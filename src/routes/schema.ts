import { Router } from 'express';
import { Registry } from '../db/registry';
import { Deps } from '../deps';
import { HttpError } from '../http';
import { diffSchemas } from '../schema/diff';
import { NormSchema, Side } from '../schema/types';

/**
 * FK tambem no formato do Backend Core ({ column, references: "tabela.coluna" }).
 * Aditivo: columns/refTable/refColumns continuam (FK composta usa estes).
 */
function withCoreForeignKeys(schema: NormSchema) {
  return {
    ...schema,
    tables: schema.tables.map((t) => ({
      ...t,
      foreignKeys: t.foreignKeys.map((fk) => ({
        ...fk,
        column: fk.columns[0] ?? '',
        references: `${fk.refTable}.${fk.refColumns[0] ?? ''}`,
      })),
    })),
  };
}

export function schemaRoutes(registry: Registry, deps: Deps): Router {
  const router = Router();

  /**
   * GET /schema/introspect?side=source|target (alias: ?connection=, usado pelo Core).
   * Um lado: { side, engine, schema, tables }. Sem parametro: { source, target }.
   */
  router.get('/schema/introspect', async (req, res) => {
    const side = req.query.side ?? req.query.connection;
    if (side !== undefined && side !== 'source' && side !== 'target') {
      throw new HttpError(400, 'INVALID_SIDE', 'side (ou connection) deve ser source ou target');
    }
    if (side) {
      res.json({ side, ...withCoreForeignKeys(await deps.introspect(registry[side])) });
      return;
    }
    const out: Partial<Record<Side, unknown>> = {};
    for (const s of ['source', 'target'] as const) out[s] = withCoreForeignKeys(await deps.introspect(registry[s]));
    res.json(out);
  });

  /** POST /schema/diff — todas as colunas pareadas, classificadas. */
  router.post('/schema/diff', async (_req, res) => {
    const [source, target] = await Promise.all([
      deps.introspect(registry.source),
      deps.introspect(registry.target),
    ]);
    // Falhar alto: um lado sem tabela quase sempre e seed/conexao no schema
    // errado, e o diff diria "falta tudo" - resultado errado e silencioso.
    for (const [side, schema] of [['source', source], ['target', target]] as const) {
      if (schema.tables.length === 0) {
        throw new HttpError(503, 'EMPTY_SCHEMA', `${side} (${schema.engine} ${schema.schema}) nao tem nenhuma tabela - o seed rodou no schema certo?`);
      }
    }
    res.json(await diffSchemas(source, target, deps.probeRunner(registry.source)));
  });

  /**
   * POST /validate/plan — previsto no documento da Fase 6, entregue na Fase 7.
   * 501 explicito em vez de 404: quem chama sabe que e "ainda nao", nao "rota errada".
   */
  router.post('/validate/plan', () => {
    throw new HttpError(501, 'NOT_IMPLEMENTED', 'validacao deterministica do plano no sandbox: Fase 7 (ver docs/ROADMAP.md)');
  });

  return router;
}
