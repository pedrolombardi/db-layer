import { NormColumn } from './types';

/**
 * O pouco de SQL que muda entre engines. Identificadores so chegam aqui
 * DEPOIS de validados contra o catalogo (allowlist); a citacao e a segunda
 * barreira, nao a primeira. Valores sempre por bind.
 */
export interface Dialect {
  quote(identifier: string): string;
  /** placeholder do bind de indice i (1-based) */
  param(i: number): string;
  limit(sql: string, n: number): string;
  charLength(expr: string, col: NormColumn): string;
  /** null quando o engine nao mede bytes desse tipo (LOB no Oracle) */
  byteLength(expr: string, col: NormColumn): string | null;
  /** COUNT(DISTINCT) nao vale para LOB no Oracle */
  canDistinct(col: NormColumn): boolean;
}

const ORACLE_LOBS = new Set(['CLOB', 'NCLOB', 'BLOB', 'LONG']);

export const mysqlDialect: Dialect = {
  quote: (id) => '`' + id.replace(/`/g, '``') + '`',
  param: () => '?',
  limit: (sql, n) => `${sql} LIMIT ${Math.trunc(n)}`,
  charLength: (e) => `CHAR_LENGTH(${e})`,
  byteLength: (e) => `LENGTH(${e})`,
  canDistinct: () => true,
};

export const oracleDialect: Dialect = {
  quote: (id) => {
    if (id.includes('"')) throw new Error(`Identificador Oracle invalido: ${id}`);
    return `"${id}"`;
  },
  param: (i) => `:${i}`,
  limit: (sql, n) => `${sql} FETCH FIRST ${Math.trunc(n)} ROWS ONLY`,
  charLength: (e) => `LENGTH(${e})`,
  byteLength: (e, col) => (ORACLE_LOBS.has(col.dataType) ? null : `LENGTHB(${e})`),
  canDistinct: (col) => !ORACLE_LOBS.has(col.dataType),
};

export function dialectFor(engine: string): Dialect {
  if (engine === 'mysql') return mysqlDialect;
  if (engine === 'oracle') return oracleDialect;
  throw new Error(`Engine sem dialeto: ${engine}`);
}
