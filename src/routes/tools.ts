import { Router } from 'express';
import { Registry } from '../db/registry';
import { Deps } from '../deps';
import { parseBody } from '../http';
import {
  charsetSchema,
  checkCharset,
  profileColumn,
  profileSchema,
  sampleSchema,
  sampleValues,
} from '../tools/tools';

/**
 * Tabela/coluna inexistente -> 200 com status NO_DATA (o que a AI Layer
 * espera). Parametro invalido, identificador invalido ou database
 * desconhecido -> 400.
 */
export function toolRoutes(registry: Registry, deps: Deps): Router {
  const router = Router();

  router.post('/tools/profile-column', async (req, res) => {
    res.json(await profileColumn(registry, deps, parseBody(profileSchema, req.body)));
  });

  router.post('/tools/sample-values', async (req, res) => {
    res.json(await sampleValues(registry, deps, parseBody(sampleSchema, req.body)));
  });

  router.post('/tools/check-charset', async (req, res) => {
    res.json(await checkCharset(registry, deps, parseBody(charsetSchema, req.body)));
  });

  return router;
}
