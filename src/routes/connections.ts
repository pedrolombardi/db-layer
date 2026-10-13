import { Router } from 'express';
import { z } from 'zod';
import { Registry } from '../db/registry';
import { DbAdapter, DbLayerError } from '../db/types';
import { HttpError } from '../http';

/** Formato original: testa um lado. */
const roleSchema = z.object({
  role: z.enum(['source', 'target']),
});

/**
 * Formato do Backend Core: a migracao inteira. A origem vem com credenciais,
 * mas no MVP o DB Layer usa as conexoes configuradas nele (credencial por
 * migracao e Fase 7). Por isso engine e database PRECISAM bater com o
 * configurado: responder "ok" sobre outro banco seria um resultado errado e
 * silencioso. A senha nunca e logada nem devolvida.
 */
const migrationSchema = z.object({
  source: z.object({ type: z.string().min(1), database: z.string().min(1).optional() }).passthrough(),
  target: z.object({ type: z.string().min(1) }).passthrough(),
});

async function checkSide(adapter: DbAdapter) {
  try {
    return { ok: true, ...(await adapter.info()) };
  } catch (err) {
    return {
      ok: false,
      readOnly: adapter.role === 'source',
      code: err instanceof DbLayerError ? err.code : 'CONNECTION_FAILED',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function connectionRoutes(registry: Registry): Router {
  const router = Router();

  /** POST /connections/test — conectividade e permissoes. */
  router.post('/connections/test', async (req, res) => {
    const migration = migrationSchema.safeParse(req.body);
    if (migration.success) {
      const { source, target } = migration.data;
      const mismatches = [
        source.type !== registry.source.engine && `origem e ${registry.source.engine}, nao ${source.type}`,
        source.database !== undefined &&
          source.database.toLowerCase() !== registry.source.schema.toLowerCase() &&
          `origem configurada e ${registry.source.schema}, nao ${source.database}`,
        target.type !== registry.target.engine && `destino e ${registry.target.engine}, nao ${target.type}`,
      ].filter(Boolean);
      if (mismatches.length > 0) {
        throw new HttpError(
          400,
          'CONNECTION_MISMATCH',
          `${mismatches.join('; ')} - no MVP o DB Layer usa as conexoes configuradas nele`,
        );
      }
      const [s, t] = await Promise.all([checkSide(registry.source), checkSide(registry.target)]);
      res.json({ source: s, target: t });
      return;
    }

    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'INVALID_BODY',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const adapter =
      parsed.data.role === 'source' ? registry.source : registry.target;

    try {
      const info = await adapter.info();
      res.json({ ok: true, ...info });
    } catch (err) {
      res.status(502).json({
        ok: false,
        code: err instanceof DbLayerError ? err.code : 'CONNECTION_FAILED',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
