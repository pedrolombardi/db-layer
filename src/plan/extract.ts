import { DbAdapter } from '../db/types';
import { HttpError } from '../http';
import { dialectFor } from '../schema/dialect';
import { NormColumn, NormSchema, NormTable, findTable } from '../schema/types';

/**
 * Amostra da ORIGEM no formato de entrada do Data Layer (POST /v1/anonymize).
 * Le dado pessoal em claro de proposito: o destino e o anonimizador, e mais
 * ninguem. Somente leitura (assertReadOnly) e identificadores do catalogo.
 */

type WireType = 'boolean' | 'integer' | 'float' | 'string';

export interface WireColumn {
  name: string;
  type: WireType;
  nullable: boolean;
  pk?: boolean;
  fk?: { table: string; column: string } | null;
}

export interface DatasetTable {
  name: string;
  columns: WireColumn[];
  rows: unknown[][];
}

export interface AnonymizeRequest {
  dataset: { tables: DatasetTable[] };
  options: { preserve: string[] };
}

const INTEGER = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT']);
const FLOAT = new Set(['DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'REAL']);
const DATES = new Set(['DATE', 'DATETIME', 'TIMESTAMP']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$#]{0,127}$/;

function wireType(c: NormColumn): WireType {
  if (INTEGER.has(c.dataType)) return 'integer';
  if (FLOAT.has(c.dataType)) return 'float';
  return 'string';
}

/**
 * Nao e dado pessoal e precisa chegar intacto ao sandbox: datas (a data zero e
 * justamente o defeito a reproduzir), ENUM e flags TINYINT(1).
 */
function preserve(c: NormColumn): boolean {
  return DATES.has(c.dataType) || c.dataType === 'ENUM' || c.dataType === 'SET' || /^TINYINT\(1\)/.test(c.type);
}

function wireValue(v: unknown, type: WireType, where: string): unknown {
  if (v === null || v === undefined) return null;
  if (type === 'integer' || type === 'float') {
    const n = Number(v);
    if (!Number.isFinite(n) || (type === 'integer' && !Number.isSafeInteger(n))) {
      throw new HttpError(422, 'UNREPRESENTABLE_VALUE', `${where}: ${String(v)} nao cabe em ${type} do Data Layer`);
    }
    return n;
  }
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (typeof v === 'object') return JSON.stringify(v); // coluna JSON: o mysql2 entrega objeto
  return String(v);
}

export async function extractSample(
  db: DbAdapter,
  schema: NormSchema,
  tables: string[] | undefined,
  limit: number,
): Promise<AnonymizeRequest> {
  let selected: NormTable[] = schema.tables;
  if (tables && tables.length > 0) {
    selected = tables.map((name) => {
      if (!IDENTIFIER.test(name)) throw new HttpError(400, 'INVALID_IDENTIFIER', `tabela invalida: ${JSON.stringify(name)}`);
      const t = findTable(schema, name);
      if (!t) throw new HttpError(400, 'UNKNOWN_TABLE', `tabela ${name} nao existe na origem`);
      return t;
    });
  }
  const d = dialectFor(db.engine);
  const out: AnonymizeRequest = { dataset: { tables: [] }, options: { preserve: [] } };

  for (const t of selected) {
    const fks = new Map(t.foreignKeys.filter((f) => f.columns.length === 1).map((f) => [f.columns[0]!, f]));
    const columns: WireColumn[] = t.columns.map((c) => {
      const fk = fks.get(c.name);
      if (preserve(c)) out.options.preserve.push(`${t.name}.${c.name}`);
      return {
        name: c.name,
        type: wireType(c),
        nullable: c.nullable,
        pk: t.primaryKey.length === 1 && t.primaryKey[0] === c.name,
        fk: fk ? { table: fk.refTable, column: fk.refColumns[0]! } : null,
      };
    });
    const order = t.primaryKey.length > 0 ? ` ORDER BY ${t.primaryKey.map((k) => d.quote(t.columns.find((c) => c.name === k)!.rawName)).join(', ')}` : '';
    const res = await db.query(
      d.limit(`SELECT ${t.columns.map((c) => d.quote(c.rawName)).join(', ')} FROM ${d.quote(t.rawName)}${order}`, limit),
    );
    const rows = res.rows.map((r) => t.columns.map((c, i) => wireValue(r[c.rawName], columns[i]!.type, `${t.name}.${c.name}`)));
    out.dataset.tables.push({ name: t.name, columns, rows });
  }
  return out;
}
