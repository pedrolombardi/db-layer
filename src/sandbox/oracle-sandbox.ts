import oracledb from 'oracledb';
import { DbLayerError } from '../db/types';

export interface SandboxConfig {
  host: string;
  port: number;
  serviceName: string;
  user: string;
  password: string;
}

/**
 * Conexao com o schema SANDBOX do Oracle: o unico lugar onde o DB Layer
 * escreve. Serve para validar um plano aprovado carregando o dataset
 * anonimizado nos tipos planejados. Nao implementa DbAdapter de proposito:
 * o resto do servico so enxerga adaptadores de leitura.
 */
export class OracleSandbox {
  private pool?: oracledb.Pool;

  constructor(private readonly cfg: SandboxConfig) {}

  get schema(): string {
    return this.cfg.user.toUpperCase();
  }

  async connect(): Promise<void> {
    try {
      this.pool = await oracledb.createPool({
        user: this.cfg.user,
        password: this.cfg.password,
        connectString: `${this.cfg.host}:${this.cfg.port}/${this.cfg.serviceName}`,
        poolMin: 0,
        poolMax: 2,
        poolIncrement: 1,
      });
    } catch (err) {
      throw new DbLayerError('CONNECTION_FAILED', `Sandbox: falha ao abrir pool (${this.schema})`, err);
    }
  }

  /**
   * A primeira conexao e o primeiro DDL no Oracle Free levam ~10 s; sem isto a
   * primeira validacao estoura o timeout de quem chama. Roda no boot.
   */
  async warmUp(): Promise<void> {
    await this.withConnection(async (conn) => {
      await conn.execute(`BEGIN EXECUTE IMMEDIATE 'CREATE TABLE "DBL_WARMUP" (X NUMBER)'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;`);
      await conn.execute(`DROP TABLE "DBL_WARMUP" PURGE`);
    });
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    await this.pool.close(5);
    this.pool = undefined;
  }

  async withConnection<T>(fn: (conn: oracledb.Connection) => Promise<T>): Promise<T> {
    if (!this.pool) throw new DbLayerError('NOT_CONNECTED', 'Sandbox: pool nao inicializado');
    const conn = await this.pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      await conn.close();
    }
  }
}
