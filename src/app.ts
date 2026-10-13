import express, { Express } from 'express';
import { Registry } from './db/registry';
import { healthRoutes } from './routes/health';
import { connectionRoutes } from './routes/connections';

export function createApp(registry: Registry): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRoutes(registry));
  app.use(connectionRoutes(registry));

  app.use((_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND' });
  });

  return app;
}
