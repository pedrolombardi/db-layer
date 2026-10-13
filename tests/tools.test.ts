import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { Registry } from '../src/db/registry';
import { DbAdapter, QueryResult } from '../src/db/types';
import { Deps } from '../src/deps';
import { NormSchema } from '../src/schema/types';
import seed from './fixtures/seed-schema.json';

/**
 * Adapters falsos que registram cada SQL recebido. Os drivers reais devolvem
 * COUNT(*) e LENGTH() como string (bigNumberStrings / fetchAsString); o fake
 * imita isso para provar que a API converte para number.
 */
function setup(answer: (sql: string) => QueryResult = () => ({ rows: [], rowCount: 0 })) {
  const queries: string[] = [];
  const adapter = (engine: 'mysql' | 'oracle', role: 'source' | 'target'): DbAdapter => ({
    engine,
    role,
    schema: 'vendas',
    connect: async () => {},
    close: async () => {},
    info: async () => {
      throw new Error('nao usado');
    },
    query: async (sql) => {
      queries.push(sql);
      return answer(sql);
    },
  });
  const registry: Registry = {
    source: adapter('mysql', 'source'),
    target: adapter('oracle', 'target'),
    connectAll: async () => {},
    closeAll: async () => {},
  };
  const schemas = { source: seed.source as NormSchema, target: seed.target as NormSchema };
  const deps: Deps = {
    introspect: async (a) => (a.role === 'source' ? schemas.source : schemas.target),
    probeRunner: () => ({ run: async () => new Map() }),
  };
  return { app: createApp(registry, deps), queries, schemas, deps, registry };
}

const one = (row: Record<string, unknown>): QueryResult => ({ rows: [row], rowCount: 1 });

describe('tools: a IA escolhe a evidencia, nunca como consultar', () => {
  it('injecao no nome da tabela -> 400 e nenhuma query executada', async () => {
    const { app, queries } = setup();
    const res = await request(app)
      .post('/tools/profile-column')
      .send({ database: 'mysql', table: 'clientes; DROP TABLE clientes', column: 'email' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IDENTIFIER');
    expect(queries).toEqual([]);
  });

  it('nome valido fora do catalogo -> 200 NO_DATA, sem query de dados', async () => {
    const { app, queries } = setup();
    const res = await request(app)
      .post('/tools/sample-values')
      .send({ database: 'mysql', table: 'fornecedores', column: 'id' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NO_DATA');
    expect(queries).toEqual([]);
  });

  it('database desconhecido -> 400', async () => {
    const { app } = setup();
    const res = await request(app).post('/tools/check-charset').send({ database: 'db2', table: 'clientes', column: 'email' });
    expect(res.status).toBe(400);
  });

  it('profile-column: drop-in do mock, numeros como number, limite em BYTE vindo do destino', async () => {
    const { app, queries } = setup(() =>
      one({ total: '10', nulls: '0', distinct_count: '10', max_len: '226', max_bytes: '226', above: '2' }),
    );
    const res = await request(app).post('/tools/profile-column').send({ database: 'mysql', table: 'clientes', column: 'email' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'OK', simulated: false, totalRows: 10, lengthThreshold: 200, thresholdUnit: 'BYTE',
      valuesAboveThreshold: 2, maxObservedLength: 226,
    });
    expect(queries[0]).toContain('LENGTH(`email`) > ?');
    expect(queries[0]).toContain('FROM `clientes`');
  });

  it('sample-values devolve inteiros como number (a regra do ativo compara com 0 e 1)', async () => {
    const { app } = setup((sql) =>
      sql.includes('COUNT(DISTINCT')
        ? one({ non_null: '10', distinct_count: '3' })
        : { rows: [{ v: 0, n: '1' }, { v: 1, n: '7' }, { v: 2, n: '2' }], rowCount: 3 },
    );
    const res = await request(app).post('/tools/sample-values').send({ database: 'mysql', table: 'clientes', column: 'ativo' });
    expect(res.body.masked).toBe(false);
    expect(res.body.values).toEqual([0, 1, 2]);
    expect(res.body.counts[1]).toEqual({ value: 1, count: 7 });
  });

  it('LGPD: coluna de alta cardinalidade (CPF) volta mascarada e os valores nem sao lidos', async () => {
    const { app, queries } = setup(() => one({ non_null: '8', distinct_count: '8' }));
    const res = await request(app).post('/tools/sample-values').send({ database: 'mysql', table: 'clientes', column: 'cpf' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'OK', masked: true, values: [], counts: [], distinctCount: 8 });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain('GROUP BY');
  });
});

describe('schema routes', () => {
  it('diff falha alto quando um lado nao tem tabela', async () => {
    const { registry, deps } = setup();
    const empty: Deps = {
      ...deps,
      introspect: async (a) =>
        a.role === 'target' ? { engine: 'oracle', schema: 'VENDAS', tables: [] } : deps.introspect(a),
    };
    const res = await request(createApp(registry, empty)).post('/schema/diff');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMPTY_SCHEMA');
  });

  it('introspect valida o side', async () => {
    const { app } = setup();
    expect((await request(app).get('/schema/introspect?side=x')).status).toBe(400);
    const res = await request(app).get('/schema/introspect?side=target');
    expect(res.body.target.tables).toHaveLength(3);
  });
});
