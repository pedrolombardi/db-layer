import express, { Express } from 'express';
import { Registry } from './db/registry';
import { Deps, defaultDeps } from './deps';
import { errorHandler } from './http';
import { healthRoutes } from './routes/health';
import { connectionRoutes } from './routes/connections';
import { schemaRoutes } from './routes/schema';
import { toolRoutes } from './routes/tools';
import { planRoutes } from './routes/plan';

export function createApp(registry: Registry, deps: Deps = defaultDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16mb' })); // dataset do sandbox

  app.use(healthRoutes(registry));
  app.use(connectionRoutes(registry));
  app.use(schemaRoutes(registry, deps));
  app.use(toolRoutes(registry, deps));
  app.use(planRoutes(registry, deps));

  app.use((_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND' });
  });
  app.use(errorHandler);

  return app;
}
