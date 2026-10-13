import { DbAdapter, Row } from '../db/types';
import { NormColumn, NormSchema, NormTable } from './types';
import { toInt, toIntOrNull } from './num';

/** Le o catalogo do engine do adapter e devolve o modelo normalizado. */
export async function introspect(adapter: DbAdapter): Promise<NormSchema> {
  if (adapter.engine === 'mysql') return introspectMysql(adapter);
  if (adapter.engine === 'oracle') return introspectOracle(adapter);
  throw new Error(`Introspeccao nao suportada para ${adapter.engine}`);
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);

function newTable(rawName: string): NormTable {
  return { name: rawName.toLowerCase(), rawName, columns: [], primaryKey: [], foreignKeys: [], checks: [] };
}

interface FkRow {
  name: string;
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

function groupFks(rows: FkRow[], tables: Map<string, NormTable>) {
  for (const r of rows) {
    const t = tables.get(r.table.toLowerCase());
    if (!t) continue;
    let fk = t.foreignKeys.find((f) => f.name === r.name.toLowerCase());
    if (!fk) {
      fk = { name: r.name.toLowerCase(), columns: [], refTable: r.refTable.toLowerCase(), refColumns: [] };
      t.foreignKeys.push(fk);
    }
    fk.columns.push(r.column.toLowerCase());
    fk.refColumns.push(r.refColumn.toLowerCase());
  }
}

// ---------------------------------------------------------------- MySQL

/** `enum('a','b''c')` -> ['a', "b'c"] */
export function parseEnumValues(columnType: string): string[] {
  const body = columnType.slice(columnType.indexOf('(') + 1, columnType.lastIndexOf(')'));
  const values: string[] = [];
  const re = /'((?:[^'\\]|''|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    values.push((m[1] ?? '').replace(/''/g, "'").replace(/\\(.)/g, '$1'));
  }
  return values;
}

const MYSQL_SIZED_STRINGS = new Set(['CHAR', 'VARCHAR', 'BINARY', 'VARBINARY']);

export function mysqlColumn(r: Row): NormColumn {
  const dataType = str(r.data_type).toUpperCase();
  const columnType = str(r.column_type);
  const extra = str(r.extra);
  const isEnum = dataType === 'ENUM' || dataType === 'SET';
  const isDecimal = dataType === 'DECIMAL' || dataType === 'NUMERIC';
  return {
    name: str(r.column_name).toLowerCase(),
    rawName: str(r.column_name),
    position: toInt(r.ordinal_position, 'ORDINAL_POSITION'),
    dataType,
    // maiusculo, mas sem mexer nos rotulos do ENUM
    type: isEnum ? dataType + columnType.slice(dataType.length) : columnType.toUpperCase(),
    length: MYSQL_SIZED_STRINGS.has(dataType) ? toIntOrNull(r.char_max_length, 'CHARACTER_MAXIMUM_LENGTH') : null,
    lengthSemantics: dataType === 'CHAR' || dataType === 'VARCHAR' ? 'CHAR' : null,
    precision: isDecimal ? toIntOrNull(r.numeric_precision, 'NUMERIC_PRECISION') : null,
    scale: isDecimal ? toIntOrNull(r.numeric_scale, 'NUMERIC_SCALE') : null,
    nullable: str(r.is_nullable).toUpperCase() === 'YES',
    autoIncrement: /auto_increment/i.test(extra),
    identityGeneration: null,
    // EXTRA pode vir "DEFAULT_GENERATED on update CURRENT_TIMESTAMP"
    onUpdateCurrentTimestamp: /on update current_timestamp/i.test(extra),
    enumValues: isEnum ? parseEnumValues(columnType) : null,
    charset: strOrNull(r.charset),
    collation: strOrNull(r.collation),
  };
}

async function introspectMysql(db: DbAdapter): Promise<NormSchema> {
  const schema = db.schema;
  const cols = await db.query(
    `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name,
            c.ORDINAL_POSITION AS ordinal_position, c.DATA_TYPE AS data_type,
            c.COLUMN_TYPE AS column_type, c.CHARACTER_MAXIMUM_LENGTH AS char_max_length,
            c.NUMERIC_PRECISION AS numeric_precision, c.NUMERIC_SCALE AS numeric_scale,
            c.IS_NULLABLE AS is_nullable, c.EXTRA AS extra,
            c.CHARACTER_SET_NAME AS charset, c.COLLATION_NAME AS collation
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
    [schema],
  );
  const tables = new Map<string, NormTable>();
  for (const r of cols.rows) {
    const raw = str(r.table_name);
    const t = tables.get(raw.toLowerCase()) ?? newTable(raw);
    tables.set(t.name, t);
    t.columns.push(mysqlColumn(r));
  }

  const keys = await db.query(
    `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
            REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL)
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [schema],
  );
  const fks: FkRow[] = [];
  for (const r of keys.rows) {
    if (str(r.name) === 'PRIMARY') {
      tables.get(str(r.table_name).toLowerCase())?.primaryKey.push(str(r.column_name).toLowerCase());
    } else {
      fks.push({ name: str(r.name), table: str(r.table_name), column: str(r.column_name), refTable: str(r.ref_table), refColumn: str(r.ref_column) });
    }
  }
  groupFks(fks, tables);

  const checks = await db.query(
    `SELECT tc.TABLE_NAME AS table_name, cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS expr
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`,
    [schema],
  );
  for (const r of checks.rows) {
    const t = tables.get(str(r.table_name).toLowerCase());
    if (!t) continue;
    const expression = str(r.expr);
    t.checks.push({
      name: str(r.name).toLowerCase(),
      columns: t.columns.filter((c) => expression.includes('`' + c.rawName + '`')).map((c) => c.name),
      expression,
    });
  }

  return { engine: 'mysql', schema, tables: [...tables.values()] };
}

// ---------------------------------------------------------------- Oracle

const ORACLE_CHAR_TYPES = new Set(['VARCHAR2', 'CHAR', 'NVARCHAR2', 'NCHAR']);

/** Bytes por caractere dos charsets mais comuns; null se desconhecido. */
export const ORACLE_MAX_BYTES: Record<string, number> = {
  AL32UTF8: 4, UTF8: 3, AL16UTF16: 2, WE8ISO8859P1: 1, WE8MSWIN1252: 1, US7ASCII: 1,
};

export function oracleColumn(r: Row, nls: { charset: string; ncharset: string }): NormColumn {
  const rawType = str(r.DATA_TYPE);
  // TIMESTAMP(6) -> TIMESTAMP; TIMESTAMP(6) WITH TIME ZONE -> TIMESTAMP WITH TIME ZONE
  const dataType = rawType.replace(/\(\d+\)/, '');
  const fractional = /\((\d+)\)/.exec(rawType)?.[1];
  const isChar = ORACLE_CHAR_TYPES.has(dataType);
  const national = dataType.startsWith('N');
  const semantics: 'CHAR' | 'BYTE' | null = !isChar
    ? null
    : national || str(r.CHAR_USED) === 'C' ? 'CHAR' : 'BYTE';
  const length = !isChar
    ? null
    : semantics === 'CHAR' ? toInt(r.CHAR_LENGTH, 'CHAR_LENGTH') : toInt(r.DATA_LENGTH, 'DATA_LENGTH');
  let precision = toIntOrNull(r.DATA_PRECISION, 'DATA_PRECISION');
  let scale = toIntOrNull(r.DATA_SCALE, 'DATA_SCALE');
  if (fractional !== undefined) {
    precision = Number(fractional);
    scale = null;
  }

  let type = rawType;
  if (isChar) {
    type = `${dataType}(${length}${semantics === 'CHAR' && !national ? ' CHAR' : ''})`;
  } else if (dataType === 'NUMBER') {
    if (precision === null) type = scale === 0 ? 'NUMBER(*,0)' : 'NUMBER';
    else type = scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
  } else if (dataType === 'FLOAT' && precision !== null) {
    type = `FLOAT(${precision})`;
  }

  const csForm = str(r.CHARACTER_SET_NAME);
  const charset = csForm === 'CHAR_CS' ? nls.charset : csForm === 'NCHAR_CS' ? nls.ncharset : null;
  const identity = str(r.IDENTITY_COLUMN) === 'YES';
  const generation = str(r.GENERATION_TYPE);

  return {
    name: str(r.COLUMN_NAME).toLowerCase(),
    rawName: str(r.COLUMN_NAME),
    position: toInt(r.COLUMN_ID, 'COLUMN_ID'),
    dataType,
    type,
    length,
    lengthSemantics: semantics,
    precision,
    scale,
    nullable: str(r.NULLABLE) === 'Y',
    autoIncrement: identity,
    identityGeneration: !identity ? null : generation === 'ALWAYS' ? 'ALWAYS' : 'BY DEFAULT',
    onUpdateCurrentTimestamp: false,
    enumValues: null,
    charset,
    collation: charset ? strOrNull(r.COLLATION) : null,
  };
}

/** NOT NULL tambem aparece como CHECK no Oracle; nao e regra de negocio. */
const NOT_NULL_CHECK = /^\s*"?[A-Za-z0-9_$#]+"?\s+IS\s+NOT\s+NULL\s*$/i;

async function introspectOracle(db: DbAdapter): Promise<NormSchema> {
  const nlsRows = await db.query(
    `SELECT parameter AS p, value AS v FROM nls_database_parameters
      WHERE parameter IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET')`,
  );
  const nlsGet = (p: string) => str(nlsRows.rows.find((r) => r.P === p)?.V);
  const nls = { charset: nlsGet('NLS_CHARACTERSET'), ncharset: nlsGet('NLS_NCHAR_CHARACTERSET') };

  const cols = await db.query(
    `SELECT c.table_name, c.column_name, c.column_id, c.data_type, c.data_length,
            c.char_length, c.char_used, c.data_precision, c.data_scale, c.nullable,
            c.identity_column, c.character_set_name, c.collation, i.generation_type
       FROM user_tab_columns c
       JOIN user_tables t ON t.table_name = c.table_name
       LEFT JOIN user_tab_identity_cols i
         ON i.table_name = c.table_name AND i.column_name = c.column_name
      WHERE t.dropped = 'NO'
      ORDER BY c.table_name, c.column_id`,
  );
  const tables = new Map<string, NormTable>();
  for (const r of cols.rows) {
    const raw = str(r.TABLE_NAME);
    const t = tables.get(raw.toLowerCase()) ?? newTable(raw);
    tables.set(t.name, t);
    t.columns.push(oracleColumn(r, nls));
  }

  const cons = await db.query(
    `SELECT c.constraint_name, c.constraint_type, c.table_name, c.search_condition_vc,
            c.r_constraint_name, cc.column_name, cc.position
       FROM user_constraints c
       JOIN user_cons_columns cc
         ON cc.constraint_name = c.constraint_name AND cc.table_name = c.table_name
      WHERE c.constraint_type IN ('P', 'U', 'R', 'C')
      ORDER BY c.constraint_name, cc.position`,
  );
  const byName = new Map<string, Row[]>();
  for (const r of cons.rows) {
    const k = str(r.CONSTRAINT_NAME);
    byName.set(k, [...(byName.get(k) ?? []), r]);
  }
  const fks: FkRow[] = [];
  for (const [name, rows] of byName) {
    const first = rows[0]!;
    const t = tables.get(str(first.TABLE_NAME).toLowerCase());
    if (!t) continue;
    const kind = str(first.CONSTRAINT_TYPE);
    if (kind === 'P') {
      t.primaryKey.push(...rows.map((r) => str(r.COLUMN_NAME).toLowerCase()));
    } else if (kind === 'C') {
      const expression = str(first.SEARCH_CONDITION_VC);
      if (NOT_NULL_CHECK.test(expression)) continue;
      t.checks.push({ name: name.toLowerCase(), columns: rows.map((r) => str(r.COLUMN_NAME).toLowerCase()), expression });
    } else if (kind === 'R') {
      const ref = byName.get(str(first.R_CONSTRAINT_NAME)) ?? [];
      rows.forEach((r, i) =>
        fks.push({
          name,
          table: str(r.TABLE_NAME),
          column: str(r.COLUMN_NAME),
          refTable: str(ref[0]?.TABLE_NAME),
          refColumn: str(ref[i]?.COLUMN_NAME),
        }),
      );
    }
  }
  groupFks(fks, tables);

  return { engine: 'oracle', schema: db.schema, tables: [...tables.values()] };
}
