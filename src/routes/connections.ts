import { Router } from 'express';
import { z } from 'zod';
import { Registry } from '../db/registry';
import { DbLayerError } from '../db/types';

const bodySchema = z.object({
  role: z.enum(['source', 'target']),
});

export function connectionRoutes(registry: Registry): Router {
  const router = Router();

  /** POST /connections/test — conectividade e permissoes de um dos lados. */
  router.post('/connections/test', async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
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
