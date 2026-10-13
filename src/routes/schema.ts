import { Router } from 'express';
import { Registry } from '../db/registry';
import { Deps } from '../deps';
import { HttpError } from '../http';
import { diffSchemas } from '../schema/diff';
import { NormSchema, Side } from '../schema/types';

export function schemaRoutes(registry: Registry, deps: Deps): Router {
  const router = Router();

  /** GET /schema/introspect?side=source|target (default: os dois) */
  router.get('/schema/introspect', async (req, res) => {
    const side = req.query.side;
    if (side !== undefined && side !== 'source' && side !== 'target') {
      throw new HttpError(400, 'INVALID_SIDE', 'side deve ser source ou target');
    }
    const sides: Side[] = side ? [side] : ['source', 'target'];
    const out: Partial<Record<Side, NormSchema>> = {};
    for (const s of sides) out[s] = await deps.introspect(registry[s]);
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

  return router;
}
