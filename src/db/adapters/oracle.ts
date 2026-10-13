import oracledb from 'oracledb';
import {
  DbAdapter,
  ConnectionInfo,
  QueryResult,
  Role,
  DbLayerError,
  Row,
} from '../types';
import { assertReadOnly } from '../readonly';

/**
 * node-oracledb roda em modo "thin" por padrao (v6+), o que dispensa a
 * instalacao do Oracle Instant Client.
 */

// NUMBER sempre como string: o float64 do JS nao representa NUMBER(38) com
// fidelidade. Definido globalmente porque vale para toda consulta do servico.
oracledb.fetchAsString = [oracledb.NUMBER, oracledb.CLOB];
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

export interface OracleConfig {
  host: string;
  port: number;
  serviceName: string;
  user: string;
  password: string;
  role: Role;
}

export class OracleAdapter implements DbAdapter {
  readonly engine = 'oracle' as const;
  readonly role: Role;

  private pool?: oracledb.Pool;
  private readonly cfg: OracleConfig;

  constructor(cfg: OracleConfig) {
    this.cfg = cfg;
    this.role = cfg.role;
  }

  get schema(): string {
    return this.cfg.user.toUpperCase();
  }

  private get connectString(): string {
    return `${this.cfg.host}:${this.cfg.port}/${this.cfg.serviceName}`;
  }

  async connect(): Promise<void> {
    try {
      this.pool = await oracledb.createPool({
        user: this.cfg.user,
        password: this.cfg.password,
        connectString: this.connectString,
        poolMin: 0,
        poolMax: 4,
        poolIncrement: 1,
        queueTimeout: 10_000,
      });
    } catch (err) {
      throw new DbLayerError(
        'CONNECTION_FAILED',
        `Oracle: falha ao abrir pool em ${this.connectString}`,
        err,
      );
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    await this.pool.close(5);
    this.pool = undefined;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (this.role === 'source') assertReadOnly(sql);
    if (!this.pool) {
      throw new DbLayerError('NOT_CONNECTED', 'Oracle: pool nao inicializado');
    }

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool.getConnection();
      const res = await conn.execute<Row>(sql, params as oracledb.BindParameters);
      const rows = (res.rows ?? []) as Row[];
      return { rows, rowCount: rows.length };
    } catch (err) {
      throw new DbLayerError('QUERY_FAILED', `Oracle: ${(err as Error).message}`, err);
    } finally {
      if (conn) await conn.close();
    }
  }

  async info(): Promise<ConnectionInfo> {
    const started = Date.now();
    if (!this.pool) {
      throw new DbLayerError('NOT_CONNECTED', 'Oracle: pool nao inicializado');
    }
    // A versao vem do handshake (oracleServerVersionString): nao depende de
    // privilegio em v$version, que o usuario da aplicacao pode nao ter.
    let version: string;
    try {
      const conn = await this.pool.getConnection();
      try {
        version = conn.oracleServerVersionString;
      } finally {
        await conn.close();
      }
    } catch (err) {
      throw new DbLayerError('CONNECTION_FAILED', `Oracle: ${(err as Error).message}`, err);
    }
    const charset = await this.query(
      `SELECT value AS v FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET'`,
    );
    return {
      engine: this.engine,
      role: this.role,
      version,
      schema: this.cfg.user.toUpperCase(),
      charset: String(charset.rows[0]?.V ?? charset.rows[0]?.v ?? 'desconhecido'),
      readOnly: this.role === 'source',
      latencyMs: Date.now() - started,
    };
  }
}
