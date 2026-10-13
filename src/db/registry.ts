import { Env } from '../config/env';
import { DbAdapter } from './types';
import { MySqlAdapter } from './adapters/mysql';
import { OracleAdapter } from './adapters/oracle';

/**
 * Instancia os adaptadores de origem e destino a partir da configuracao.
 * O restante do servico recebe `DbAdapter` — nunca um driver concreto.
 */
export interface Registry {
  source: DbAdapter;
  target: DbAdapter;
  connectAll(): Promise<void>;
  closeAll(): Promise<void>;
}

export function createRegistry(env: Env): Registry {
  const source = new MySqlAdapter({
    host: env.SRC_HOST,
    port: env.SRC_PORT,
    user: env.SRC_USER,
    password: env.SRC_PASSWORD,
    database: env.SRC_DATABASE,
    role: 'source',
  });

  const target = new OracleAdapter({
    host: env.TGT_HOST,
    port: env.TGT_PORT,
    serviceName: env.TGT_SERVICE,
    user: env.TGT_USER,
    password: env.TGT_PASSWORD,
    role: 'target',
  });

  return {
    source,
    target,
    async connectAll() {
      await Promise.all([source.connect(), target.connect()]);
    },
    async closeAll() {
      await Promise.allSettled([source.close(), target.close()]);
    },
  };
}
