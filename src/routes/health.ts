import { Router } from 'express';
import { Registry } from '../db/registry';
import { DbLayerError } from '../db/types';

export function healthRoutes(registry: Registry): Router {
  const router = Router();

  /** Liveness: o processo esta de pe. Nao toca nos bancos. */
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'db-layer' });
  });

  /**
   * Readiness: abre conexao REAL nos dois bancos.
   *
   * E esta rota que prova o walking skeleton — se ela responde verde, o risco
   * tecnico do servico (Node + driver Oracle + container) esta vencido.
   */
  router.get('/health/db', async (_req, res) => {
    const results = await Promise.allSettled([
      registry.source.info(),
      registry.target.info(),
    ]);

    const [source, target] = results;
    const body = {
      status: results.every((r) => r.status === 'fulfilled') ? 'ok' : 'degraded',
      source: describe(source),
      target: describe(target),
    };

    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  return router;
}

function describe(result: PromiseSettledResult<unknown>) {
  if (result.status === 'fulfilled') {
    return { connected: true, ...(result.value as object) };
  }
  const reason = result.reason;
  return {
    connected: false,
    code: reason instanceof DbLayerError ? reason.code : 'CONNECTION_FAILED',
    error: reason instanceof Error ? reason.message : String(reason),
  };
}
