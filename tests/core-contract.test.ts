import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../src/app';
import { Registry } from '../src/db/registry';
import { ConnectionInfo, DbAdapter } from '../src/db/types';
import { Deps } from '../src/deps';
import { NormSchema } from '../src/schema/types';
import seed from './fixtures/seed-schema.json';

/**
 * Teste de contrato com o consumidor: copia dos schemas Zod que o Backend Core
 * (Giovanni, backend/src/schemas.ts) usa para validar as respostas do DB Layer.
 * Se este teste quebrar, o Core marca a migracao como FAILED com
 * "resposta fora do contrato esperado".
 */
const core = {
  connectionTestResponse: z.object({
    source: z.object({ ok: z.boolean(), readOnly: z.boolean() }),
    target: z.object({ ok: z.boolean() }),
  }),
  introspectResponse: z.object({
    tables: z.array(
      z.object({
        name: z.string(),
        columns: z.array(z.object({ name: z.string(), type: z.string() })),
        foreignKeys: z.array(z.object({ column: z.string(), references: z.string() })).default([]),
      }),
    ),
  }),
  diffResponse: z.object({
    conflicts: z.array(
      z.object({
        id: z.string(),
        table: z.string(),
        column: z.string(),
        sourceType: z.string(),
        targetType: z.string(),
        kind: z.enum(['mechanical', 'judgement']),
        description: z.string(),
        resolution: z.string().optional(),
      }),
    ),
  }),
};

/** Corpo que o Core manda (createMigrationSchema), com a senha da origem. */
const coreBody = {
  source: { type: 'mysql', host: 'mysql', database: 'vendas', user: 'readonly', password: 'segredo' },
  target: { type: 'oracle' },
};

function setup() {
  const adapter = (engine: 'mysql' | 'oracle', role: 'source' | 'target'): DbAdapter => {
    const info: ConnectionInfo = {
      engine, role, version: 'test', schema: 'vendas', charset: 'utf8mb4', readOnly: role === 'source', latencyMs: 1,
    };
    return {
      engine, role, schema: 'vendas',
      connect: async () => {}, close: async () => {},
      info: async () => info,
      query: async () => ({ rows: [], rowCount: 0 }),
    };
  };
  const registry: Registry = {
    source: adapter('mysql', 'source'),
    target: adapter('oracle', 'target'),
    connectAll: async () => {},
    closeAll: async () => {},
  };
  const deps: Deps = {
    introspect: async (a) => (a.role === 'source' ? seed.source : seed.target) as NormSchema,
    probeRunner: () => ({ run: async () => new Map() }),
  };
  return createApp(registry, deps);
}

describe('contrato com o Backend Core', () => {
  it('POST /connections/test aceita o corpo do Core e responde no formato dele, sem devolver a senha', async () => {
    const res = await request(setup()).post('/connections/test').send(coreBody);
    expect(res.status).toBe(200);
    expect(core.connectionTestResponse.safeParse(res.body).success).toBe(true);
    expect(res.body.source.readOnly).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('segredo');
  });

  it('POST /connections/test recusa (400) banco diferente do configurado, em vez de responder ok sobre outro banco', async () => {
    const res = await request(setup())
      .post('/connections/test')
      .send({ ...coreBody, source: { ...coreBody.source, database: 'vendas_prod' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONNECTION_MISMATCH');
  });

  it('GET /schema/introspect?connection=source responde no formato do Core', async () => {
    const res = await request(setup()).get('/schema/introspect?connection=source');
    expect(res.status).toBe(200);
    const parsed = core.introspectResponse.safeParse(res.body);
    expect(parsed.success).toBe(true);
    const pedidos = parsed.data!.tables.find((t) => t.name === 'pedidos')!;
    expect(pedidos.foreignKeys).toEqual([{ column: 'cliente_id', references: 'clientes.id' }]);
  });

  it('POST /schema/diff responde no formato do Core; mecanico traz resolution (senao o Core manda para a IA)', async () => {
    const res = await request(setup()).post('/schema/diff').send(coreBody);
    expect(res.status).toBe(200);
    const parsed = core.diffResponse.safeParse(res.body);
    expect(parsed.success).toBe(true);
    for (const c of parsed.data!.conflicts) {
      expect(c.kind === 'mechanical' ? typeof c.resolution : 'n/a').toBe(c.kind === 'mechanical' ? 'string' : 'n/a');
    }
    const id = parsed.data!.conflicts.find((c) => c.id === 'clientes.id')!;
    expect(id).toMatchObject({ kind: 'mechanical', sourceType: 'INT', targetType: 'NUMBER(10)' });
  });

  it('POST /validate/plan responde 501 explicito (Fase 7), nao 404', async () => {
    const res = await request(setup()).post('/validate/plan').send({});
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
  });
});
