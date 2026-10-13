import { z } from 'zod';
import { Registry } from '../db/registry';
import { DbAdapter } from '../db/types';
import { Deps } from '../deps';
import { HttpError } from '../http';
import { dialectFor } from '../schema/dialect';
import { ORACLE_MAX_BYTES } from '../schema/introspect';
import { toInt, toIntOrNull } from '../schema/num';
import { NormColumn, NormTable, Side, findColumn, findTable } from '../schema/types';

/**
 * Tools de evidencia para a AI Layer (drop-in dos mocks do Erick, com
 * `simulated: false`). A IA escolhe QUAL evidencia quer, nunca COMO consultar:
 * nenhum SQL vem de fora; tabela/coluna passam por (1) sintaxe de
 * identificador e (2) allowlist do catalogo introspectado. Valores por bind.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$#]{0,127}$/;

const baseSchema = z.object({
  database: z.enum(['mysql', 'oracle']),
  table: z.string().min(1),
  column: z.string().min(1),
  side: z.enum(['source', 'target']).optional(),
});
export const profileSchema = baseSchema.extend({ threshold: z.number().int().positive().optional() });
export const sampleSchema = baseSchema.extend({ limit: z.number().int().min(1).max(100).default(20) });
export const charsetSchema = baseSchema;

type BaseInput = z.infer<typeof baseSchema>;

interface Resolved {
  side: Side;
  adapter: DbAdapter;
  table: NormTable;
  column: NormColumn;
}

interface NoData {
  status: 'NO_DATA';
  simulated: false;
  database: string;
  table: string;
  column: string;
  reason: string;
}

const otherSide = (s: Side): Side => (s === 'source' ? 'target' : 'source');

export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new HttpError(400, 'INVALID_BODY', msg);
  }
  return parsed.data;
}

function pickSide(registry: Registry, input: BaseInput): Side {
  const candidates = (['source', 'target'] as const).filter((s) => registry[s].engine === input.database);
  if (input.side) {
    if (!candidates.includes(input.side)) {
      throw new HttpError(400, 'SIDE_MISMATCH', `o lado ${input.side} nao e ${input.database}`);
    }
    return input.side;
  }
  if (candidates.length === 0) throw new HttpError(400, 'UNKNOWN_DATABASE', `nenhuma conexao ${input.database}`);
  if (candidates.length > 1) {
    throw new HttpError(400, 'AMBIGUOUS_DATABASE', `origem e destino sao ${input.database}: informe "side"`);
  }
  return candidates[0]!;
}

async function resolve(registry: Registry, deps: Deps, input: BaseInput): Promise<Resolved | NoData> {
  // Barreira 1: sintaxe. "clientes; DROP TABLE clientes" para aqui, sem query.
  for (const [field, value] of [['table', input.table], ['column', input.column]] as const) {
    if (!IDENTIFIER.test(value)) {
      throw new HttpError(
        400,
        'INVALID_IDENTIFIER',
        `${field} invalido: ${JSON.stringify(value)} - nenhuma consulta foi executada`,
      );
    }
  }
  const side = pickSide(registry, input);
  const adapter = registry[side];
  // Barreira 2: allowlist. So nome que existe no catalogo entra numa query.
  const schema = await deps.introspect(adapter);
  const table = findTable(schema, input.table);
  const column = table && findColumn(table, input.column);
  if (!table || !column) {
    return {
      status: 'NO_DATA',
      simulated: false,
      database: input.database,
      table: input.table,
      column: input.column,
      reason: !table
        ? `tabela ${input.table} nao existe em ${side}`
        : `coluna ${input.table}.${input.column} nao existe em ${side}`,
    };
  }
  return { side, adapter, table, column };
}

const isNoData = (r: Resolved | NoData): r is NoData => 'status' in r;

function header(r: Resolved) {
  return {
    status: 'OK' as const,
    simulated: false as const,
    database: r.adapter.engine,
    side: r.side,
    table: r.table.name,
    column: r.column.name,
  };
}

export async function profileColumn(registry: Registry, deps: Deps, input: z.infer<typeof profileSchema>) {
  const r = await resolve(registry, deps, input);
  if (isNoData(r)) return r;

  // lengthThreshold = tamanho declarado da coluna correspondente no outro lado
  let threshold: number | null = input.threshold ?? null;
  let thresholdSource: string | null = threshold !== null ? 'request' : null;
  let unit: 'CHAR' | 'BYTE' = 'CHAR';
  const other = otherSide(r.side);
  const otherTable = findTable(await deps.introspect(registry[other]), r.table.name);
  const counterpart = otherTable && findColumn(otherTable, r.column.name);
  if (counterpart?.lengthSemantics) unit = counterpart.lengthSemantics;
  if (threshold === null && counterpart?.length != null) {
    threshold = counterpart.length;
    thresholdSource = `${other}.declared`;
  }

  const d = dialectFor(r.adapter.engine);
  const q = d.quote(r.column.rawName);
  const chars = d.charLength(q, r.column);
  const bytes = d.byteLength(q, r.column);
  const params: unknown[] = [];
  const select = [
    `COUNT(*) AS ${d.quote('total')}`,
    `SUM(CASE WHEN ${q} IS NULL THEN 1 ELSE 0 END) AS ${d.quote('nulls')}`,
    `${d.canDistinct(r.column) ? `COUNT(DISTINCT ${q})` : 'NULL'} AS ${d.quote('distinct_count')}`,
    `MAX(${chars}) AS ${d.quote('max_len')}`,
    `${bytes ? `MAX(${bytes})` : 'NULL'} AS ${d.quote('max_bytes')}`,
  ];
  if (threshold !== null) {
    // Mede na unidade do outro lado: bytes se ele e BYTE, caracteres se CHAR.
    const measured = unit === 'BYTE' && bytes ? bytes : chars;
    params.push(threshold);
    select.push(`SUM(CASE WHEN ${measured} > ${d.param(1)} THEN 1 ELSE 0 END) AS ${d.quote('above')}`);
  }
  const res = await r.adapter.query(`SELECT ${select.join(', ')} FROM ${d.quote(r.table.rawName)}`, params);
  const row = res.rows[0] ?? {};

  return {
    ...header(r),
    totalRows: toInt(row.total, 'COUNT(*)'),
    nullCount: toIntOrNull(row.nulls, 'nullCount') ?? 0,
    distinctCount: toIntOrNull(row.distinct_count, 'distinctCount'),
    lengthThreshold: threshold,
    thresholdSource,
    thresholdUnit: threshold !== null ? unit : null,
    valuesAboveThreshold: threshold !== null ? (toIntOrNull(row.above, 'valuesAboveThreshold') ?? 0) : null,
    maxObservedLength: toIntOrNull(row.max_len, 'maxObservedLength'),
    maxObservedBytes: toIntOrNull(row.max_bytes, 'maxObservedBytes'),
  };
}

/**
 * LGPD: sample-values so devolve valores de colunas CATEGORICAS (poucos
 * distintos, que se repetem: flags, status, ENUM). Coluna de alta
 * cardinalidade (CPF, e-mail, nome, valor monetario) pode ser dado pessoal e,
 * via AI Layer, iria parar num provedor de LLM: volta mascarada, so com
 * contagens. ENUM e sempre categorico (os rotulos sao metadado do schema).
 */
const MAX_CATEGORICAL = 20;

function isCategorical(col: NormColumn, distinct: number, nonNull: number): boolean {
  if (col.dataType === 'ENUM') return true;
  return distinct <= MAX_CATEGORICAL && distinct * 2 <= nonNull;
}

export async function sampleValues(registry: Registry, deps: Deps, input: z.infer<typeof sampleSchema>) {
  const r = await resolve(registry, deps, input);
  if (isNoData(r)) return r;
  const d = dialectFor(r.adapter.engine);
  if (!d.canDistinct(r.column)) {
    throw new HttpError(400, 'UNSUPPORTED_TYPE', `${r.column.type} nao permite amostra de distintos`);
  }
  const q = d.quote(r.column.rawName);
  const t = d.quote(r.table.rawName);
  const stats = await r.adapter.query(
    `SELECT COUNT(${q}) AS ${d.quote('non_null')}, COUNT(DISTINCT ${q}) AS ${d.quote('distinct_count')} FROM ${t}`,
  );
  const nonNullCount = toInt(stats.rows[0]?.non_null, 'COUNT(col)');
  const distinctCount = toInt(stats.rows[0]?.distinct_count, 'COUNT(DISTINCT col)');

  if (!isCategorical(r.column, distinctCount, nonNullCount)) {
    return {
      ...header(r),
      masked: true,
      reason: `alta cardinalidade (${distinctCount} distintos em ${nonNullCount} valores): pode ser dado pessoal, valores nao sao expostos`,
      distinctCount,
      nonNullCount,
      values: [],
      counts: [],
      truncated: false,
    };
  }

  const res = await r.adapter.query(
    d.limit(`SELECT ${q} AS ${d.quote('v')}, COUNT(*) AS ${d.quote('n')} FROM ${t} WHERE ${q} IS NOT NULL GROUP BY ${q} ORDER BY ${q}`, input.limit + 1),
  );
  const rows = res.rows.slice(0, input.limit);
  // Valores como o driver entrega: TINYINT vem number (a regra do Erick
  // compara com 0 e 1); NUMBER/DECIMAL vem string para nao perder precisao.
  return {
    ...header(r),
    masked: false,
    distinctCount,
    nonNullCount,
    values: rows.map((x) => x.v),
    counts: rows.map((x) => ({ value: x.v, count: toInt(x.n, 'COUNT(*)') })),
    truncated: res.rows.length > input.limit,
  };
}

export async function checkCharset(registry: Registry, deps: Deps, input: z.infer<typeof charsetSchema>) {
  const r = await resolve(registry, deps, input);
  if (isNoData(r)) return r;
  let maxBytesPerCharacter: number | null = null;
  if (r.column.charset) {
    if (r.adapter.engine === 'mysql') {
      const res = await r.adapter.query(
        'SELECT MAXLEN AS maxlen FROM information_schema.CHARACTER_SETS WHERE CHARACTER_SET_NAME = ?',
        [r.column.charset],
      );
      maxBytesPerCharacter = toIntOrNull(res.rows[0]?.maxlen, 'MAXLEN');
    } else {
      maxBytesPerCharacter = ORACLE_MAX_BYTES[r.column.charset] ?? null;
    }
  }
  return {
    ...header(r),
    charset: r.column.charset,
    collation: r.column.collation,
    maxBytesPerCharacter,
  };
}
