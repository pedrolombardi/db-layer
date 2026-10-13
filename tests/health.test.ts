import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { Registry } from '../src/db/registry';
import { DbAdapter, ConnectionInfo, DbLayerError } from '../src/db/types';

/** Adaptador falso: permite testar as rotas sem subir banco nenhum. */
function fakeAdapter(role: 'source' | 'target', ok: boolean): DbAdapter {
  const info: ConnectionInfo = {
    engine: role === 'source' ? 'mysql' : 'oracle',
    role,
    version: '0.0-test',
    schema: 'vendas',
    charset: 'utf8mb4',
    readOnly: role === 'source',
    latencyMs: 1,
  };
  return {
    engine: info.engine,
    role,
    schema: 'vendas',
    connect: async () => {},
    close: async () => {},
    info: async () => {
      if (!ok) throw new DbLayerError('CONNECTION_FAILED', 'fora do ar');
      return info;
    },
    query: async () => ({ rows: [], rowCount: 0 }),
  };
}

function registryWith(sourceOk: boolean, targetOk: boolean): Registry {
  return {
    source: fakeAdapter('source', sourceOk),
    target: fakeAdapter('target', targetOk),
    connectAll: async () => {},
    closeAll: async () => {},
  };
}

describe('GET /health', () => {
  it('responde ok sem tocar nos bancos', async () => {
    const res = await request(createApp(registryWith(false, false))).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /health/db', () => {
  it('200 quando os dois bancos respondem', async () => {
    const res = await request(createApp(registryWith(true, true))).get('/health/db');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.source.connected).toBe(true);
    expect(res.body.target.connected).toBe(true);
    expect(res.body.source.readOnly).toBe(true);
  });

  it('503 e identifica qual lado caiu', async () => {
    const res = await request(createApp(registryWith(true, false))).get('/health/db');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.source.connected).toBe(true);
    expect(res.body.target.connected).toBe(false);
    expect(res.body.target.code).toBe('CONNECTION_FAILED');
  });
});

describe('POST /connections/test', () => {
  it('valida o corpo', async () => {
    const res = await request(createApp(registryWith(true, true)))
      .post('/connections/test')
      .send({ role: 'invalido' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('retorna os metadados da conexao', async () => {
    const res = await request(createApp(registryWith(true, true)))
      .post('/connections/test')
      .send({ role: 'target' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.engine).toBe('oracle');
  });
});
