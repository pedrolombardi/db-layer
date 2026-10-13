import { ErrorRequestHandler } from 'express';
import { DbLayerError } from './db/types';

/** Erro com status HTTP e codigo estavel para a API. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const DB_STATUS: Record<DbLayerError['code'], number> = {
  CONNECTION_FAILED: 503,
  NOT_CONNECTED: 503,
  QUERY_FAILED: 502,
  READ_ONLY_VIOLATION: 403,
  NOT_SUPPORTED: 400,
};

/**
 * Express 5 encaminha para ca as promises rejeitadas dos handlers. Sem isto a
 * resposta padrao seria HTML; aqui todo erro sai em JSON, com codigo estavel.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ code: err.code, error: err.message });
    return;
  }
  if (err instanceof DbLayerError) {
    res.status(DB_STATUS[err.code] ?? 500).json({ code: err.code, error: err.message });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ code: 'INVALID_JSON', error: 'corpo nao e JSON valido' });
    return;
  }
  console.error('[db-layer] erro nao tratado:', err);
  res.status(500).json({ code: 'INTERNAL', error: err instanceof Error ? err.message : String(err) });
};
