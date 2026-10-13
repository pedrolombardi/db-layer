/**
 * Contrato comum a todos os adaptadores de banco.
 *
 * A logica de dominio (introspeccao, diff, tools, validacao) depende SOMENTE
 * desta interface — nunca de um driver especifico. Adicionar suporte a um novo
 * banco significa escrever um novo adaptador, sem tocar no dominio.
 */

export type Engine = 'mysql' | 'oracle' | 'postgres';

/** Papel da conexao. `source` e sempre aberto em modo somente leitura. */
export type Role = 'source' | 'target';

export interface ConnectionInfo {
  engine: Engine;
  role: Role;
  /** versao reportada pelo servidor */
  version: string;
  /** schema/database ao qual a conexao esta apontada */
  schema: string;
  /** charset/encoding efetivo */
  charset: string;
  /** true quando o adaptador garante que nao ha escrita possivel */
  readOnly: boolean;
  /** tempo do handshake em milissegundos */
  latencyMs: number;
}

/**
 * Uma linha generica.
 *
 * IMPORTANTE: valores numericos de alta precisao (NUMBER do Oracle, DECIMAL do
 * MySQL) chegam aqui como `string`, nunca como `number`. O float64 do JavaScript
 * nao representa esses valores com fidelidade, e uma das verificacoes do servico
 * e justamente "precisao e escala preservadas" — perder precisao no proprio
 * verificador invalidaria o resultado.
 */
export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  rowCount: number;
}

export interface DbAdapter {
  readonly engine: Engine;
  readonly role: Role;

  /** abre o pool de conexoes */
  connect(): Promise<void>;

  /** fecha o pool; idempotente */
  close(): Promise<void>;

  /** metadados da conexao, usados por /health/db e /connections/test */
  info(): Promise<ConnectionInfo>;

  /**
   * Executa uma consulta parametrizada.
   *
   * Adaptadores com `role: 'source'` recusam qualquer statement que nao seja
   * de leitura — a garantia nao depende apenas da permissao do usuario no banco.
   */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

/** Erro de dominio do DB Layer, com codigo estavel para a API. */
export class DbLayerError extends Error {
  constructor(
    public readonly code:
      | 'CONNECTION_FAILED'
      | 'READ_ONLY_VIOLATION'
      | 'QUERY_FAILED'
      | 'NOT_CONNECTED',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DbLayerError';
  }
}
