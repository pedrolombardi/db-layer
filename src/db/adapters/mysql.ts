import mysql from 'mysql2/promise';
import {
  DbAdapter,
  ConnectionInfo,
  QueryResult,
  Role,
  DbLayerError,
  Row,
} from '../types';
import { assertReadOnly } from '../readonly';

export interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  role: Role;
}

export class MySqlAdapter implements DbAdapter {
  readonly engine = 'mysql' as const;
  readonly role: Role;

  private pool?: mysql.Pool;
  private readonly cfg: MySqlConfig;

  constructor(cfg: MySqlConfig) {
    this.cfg = cfg;
    this.role = cfg.role;
  }

  get schema(): string {
    return this.cfg.database;
  }

  async connect(): Promise<void> {
    try {
      this.pool = mysql.createPool({
        host: this.cfg.host,
        port: this.cfg.port,
        user: this.cfg.user,
        password: this.cfg.password,
        database: this.cfg.database,
        connectionLimit: 4,
        waitForConnections: true,

        // DECIMAL como string (default da lib, explicitado de proposito):
        // o float64 do JS nao representa DECIMAL(38,10) com fidelidade.
        decimalNumbers: false,

        // BIGINT como string pelo mesmo motivo (Number.MAX_SAFE_INTEGER).
        supportBigNumbers: true,
        bigNumberStrings: true,

        // Datas como string. Bancos legados contem '0000-00-00', que nao tem
        // equivalente em Date do JS e viraria null silenciosamente — justamente
        // um dos conflitos que o servico precisa enxergar.
        dateStrings: true,

        // nunca permitir multiplos statements na mesma chamada
        multipleStatements: false,
      });
    } catch (err) {
      throw new DbLayerError(
        'CONNECTION_FAILED',
        `MySQL: falha ao abrir pool em ${this.cfg.host}:${this.cfg.port}`,
        err,
      );
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = undefined;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (this.role === 'source') assertReadOnly(sql);
    if (!this.pool) {
      throw new DbLayerError('NOT_CONNECTED', 'MySQL: pool nao inicializado');
    }

    try {
      const [rows] = await this.pool.query(sql, params);
      const list = Array.isArray(rows) ? (rows as Row[]) : [];
      return { rows: list, rowCount: list.length };
    } catch (err) {
      throw new DbLayerError('QUERY_FAILED', `MySQL: ${(err as Error).message}`, err);
    }
  }

  async info(): Promise<ConnectionInfo> {
    const started = Date.now();
    const version = await this.query('SELECT VERSION() AS v');
    const charset = await this.query(
      `SELECT @@character_set_database AS v`,
    );
    return {
      engine: this.engine,
      role: this.role,
      version: String(version.rows[0]?.v ?? 'desconhecida'),
      schema: this.cfg.database,
      charset: String(charset.rows[0]?.v ?? 'desconhecido'),
      readOnly: this.role === 'source',
      latencyMs: Date.now() - started,
    };
  }
}
