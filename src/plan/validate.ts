import oracledb from 'oracledb';
import { Registry } from '../db/registry';
import { DbAdapter } from '../db/types';
import { Deps } from '../deps';
import { HttpError } from '../http';
import { dialectFor } from '../schema/dialect';
import { toInt, toIntOrNull } from '../schema/num';
import { PlanConflict, PlannedColumn, PlannedTable, isDateType, isInvalidDate, loadOrder, planTables } from './model';

/**
 * Validacao deterministica de um plano aprovado (documento da Fase 6):
 *  1. fatos medidos na ORIGEM contra os tipos planejados (truncamento,
 *     precisao/escala, nulos, datas invalidas) - nao dependem da anonimizacao;
 *  2. carga do dataset ANONIMIZADO no schema SANDBOX, nos tipos planejados:
 *     contagem de linhas, integridade das FKs e erros reais do Oracle.
 * Quem valida nunca e quem propos: nada aqui consulta a IA.
 */

/** O que a validacao usa do dataset anonimizado (formato do Data Layer). */
export interface LoadTable {
  name: string;
  columns: { name: string }[];
  rows: unknown[][];
}

export interface Check {
  name: 'row_count' | 'silent_truncation' | 'foreign_keys' | 'type_precision_scale' | 'null_count';
  passed: boolean;
  detail: string;
}

interface ColumnFacts {
  nulls: number;
  invalidDates: number;
  above: number;
  maxLength: number | null;
  intDigits: number | null;
}

const STRING_TYPES = new Set(['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR']);
const NUMERIC_SOURCE = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC']);
const SOURCE_DATES = new Set(['DATE', 'DATETIME', 'TIMESTAMP']);

/** Uma consulta agregada por tabela na origem (somente leitura). */
export async function sourceFacts(db: DbAdapter, t: PlannedTable): Promise<Map<string, ColumnFacts>> {
  const out = new Map<string, ColumnFacts>();
  if (!t.source) return out;
  const d = dialectFor(db.engine);
  const select: string[] = [];
  const params: unknown[] = [];
  const cols = t.columns.filter((c) => c.source);
  cols.forEach((c, i) => {
    const s = c.source!;
    const q = d.quote(s.rawName);
    select.push(`SUM(CASE WHEN ${q} IS NULL THEN 1 ELSE 0 END) AS ${d.quote(`n${i}`)}`);
    if (isDateType(c.base) && SOURCE_DATES.has(s.dataType) && db.engine === 'mysql') {
      const txt = `CAST(${q} AS CHAR)`;
      select.push(`SUM(CASE WHEN ${txt} LIKE '0000-%' OR SUBSTRING(${txt}, 6, 2) = '00' OR SUBSTRING(${txt}, 9, 2) = '00' THEN 1 ELSE 0 END) AS ${d.quote(`z${i}`)}`);
    }
    if (STRING_TYPES.has(c.base) && c.length !== null) {
      const len = (c.semantics === 'BYTE' ? d.byteLength(q, s) : null) ?? d.charLength(q, s);
      params.push(c.length);
      select.push(`MAX(${len}) AS ${d.quote(`m${i}`)}`, `SUM(CASE WHEN ${len} > ${d.param(params.length)} THEN 1 ELSE 0 END) AS ${d.quote(`a${i}`)}`);
    }
    if (c.base === 'NUMBER' && c.precision !== null && NUMERIC_SOURCE.has(s.dataType)) {
      select.push(`FLOOR(MAX(ABS(${q}))) AS ${d.quote(`i${i}`)}`);
    }
  });
  if (select.length === 0) return out;
  const res = await db.query(`SELECT ${select.join(', ')} FROM ${d.quote(t.source.rawName)}`, params);
  const row = res.rows[0] ?? {};
  cols.forEach((c, i) => {
    const intMax = row[`i${i}`];
    out.set(c.name, {
      nulls: toIntOrNull(row[`n${i}`], 'nulls') ?? 0,
      invalidDates: toIntOrNull(row[`z${i}`], 'invalidDates') ?? 0,
      above: toIntOrNull(row[`a${i}`], 'above') ?? 0,
      maxLength: toIntOrNull(row[`m${i}`], 'maxLength'),
      intDigits: intMax === null || intMax === undefined ? null : String(intMax).replace(/^-/, '').length,
    });
  });
  return out;
}

/** FK com filho apontando para pai inexistente (no mesmo banco). */
function orphanSql(child: string, col: string, parent: string, pcol: string, quote: (s: string) => string): string {
  return `SELECT COUNT(*) AS ${quote('n')} FROM ${quote(child)} c WHERE c.${quote(col)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${quote(parent)} p WHERE p.${quote(pcol)} = c.${quote(col)})`;
}

function rawOf(t: PlannedTable, col: string): string {
  return t.columns.find((c) => c.name === col)?.rawName ?? col.toUpperCase();
}

function sandboxNullable(c: PlannedColumn, datasetInvalid: number, sourceInvalid: number): boolean {
  return c.nullable || (c.onInvalid?.kind === 'null' && datasetInvalid + sourceInvalid > 0);
}

/** Valor do dataset convertido para o bind (string) no tipo planejado. */
function toBind(c: PlannedColumn, v: unknown, converted: { n: number }): string | null {
  if (v === null || v === undefined) return null;
  if (isDateType(c.base)) {
    const s = String(v);
    if (isInvalidDate(s)) {
      if (c.onInvalid?.kind === 'null') {
        converted.n++;
        return null;
      }
      if (c.onInvalid?.kind === 'default') {
        converted.n++;
        return `${c.onInvalid.value} 00:00:00`;
      }
      return s; // sem decisao: o Oracle recusa, e isso vira uma falha da validacao
    }
    return s.length === 10 ? `${s} 00:00:00` : s.slice(0, 19);
  }
  const src = c.source;
  if (src && (src.dataType === 'DECIMAL' || src.dataType === 'NUMERIC') && typeof v === 'number') {
    // o anonimizador perturba os decimais; o dataset volta ao tipo da origem
    return v.toFixed(src.scale ?? 0);
  }
  if (src && NUMERIC_SOURCE.has(src.dataType) && typeof v === 'number') return String(Math.round(v));
  return String(v);
}

const ORA = (err: { errorNum?: number; message?: string }) => err.errorNum ?? Number(/ORA-(\d+)/.exec(err.message ?? '')?.[1] ?? 0);

export async function validatePlan(registry: Registry, deps: Deps, conflicts: PlanConflict[], dataset: LoadTable[]) {
  const sandbox = registry.sandbox;
  if (!sandbox) throw new HttpError(503, 'SANDBOX_UNAVAILABLE', 'schema sandbox nao configurado');
  const [source, target] = await Promise.all([deps.introspect(registry.source), deps.introspect(registry.target)]);
  const tables = loadOrder(planTables(source, target, conflicts));
  const issues: Record<Check['name'], string[]> = { row_count: [], silent_truncation: [], foreign_keys: [], type_precision_scale: [], null_count: [] };
  const counts: string[] = [];
  const fkNotes: string[] = [];
  const invalidSource = new Map<string, number>();

  // 1. Fatos da origem contra o plano
  const facts = new Map<string, Map<string, ColumnFacts>>();
  for (const t of tables) facts.set(t.name, await sourceFacts(registry.source, t));
  for (const t of tables) {
    for (const c of t.columns) {
      const f = facts.get(t.name)?.get(c.name);
      if (!f || !c.source) continue;
      const id = `${t.name}.${c.name}`;
      invalidSource.set(id, f.invalidDates);
      if (f.above > 0) issues.silent_truncation.push(`${id}: ${f.above} valor(es) da origem nao cabem em ${c.type} (max. ${f.maxLength})`);
      if (c.base === 'NUMBER' && c.precision !== null) {
        const scale = c.scale ?? 0;
        if ((c.source.scale ?? 0) > scale) issues.type_precision_scale.push(`${id}: escala da origem (${c.source.scale}) maior que a planejada (${scale}) - arredondamento silencioso`);
        if (f.intDigits !== null && f.intDigits > c.precision - scale) issues.type_precision_scale.push(`${id}: ${f.intDigits} digitos inteiros nao cabem em ${c.type}`);
      }
      if (f.invalidDates > 0 && !c.onInvalid) issues.type_precision_scale.push(`${id}: ${f.invalidDates} data(s) invalida(s) na origem sem decisao no plano`);
      if (!c.nullable && f.nulls > 0) issues.null_count.push(`${id}: ${f.nulls} nulo(s) na origem e o destino e NOT NULL`);
    }
  }

  // 2. Carga do dataset anonimizado no sandbox, nos tipos planejados
  await sandbox.exclusive(() => sandbox.withConnection(async (conn) => {
    const loaded = tables.filter((t) => dataset.some((d) => d.name.toLowerCase() === t.name));
    for (const t of [...loaded].reverse()) {
      await conn.execute(`BEGIN EXECUTE IMMEDIATE 'DROP TABLE "${t.rawName}" CASCADE CONSTRAINTS PURGE'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`);
    }
    for (const t of loaded) {
      const data = dataset.find((d) => d.name.toLowerCase() === t.name)!;
      const index = new Map(data.columns.map((c, i) => [c.name.toLowerCase(), i]));
      const converted = new Map<string, { n: number }>(t.columns.map((c) => [c.name, { n: 0 }]));
      const datasetInvalid = (c: PlannedColumn) =>
        isDateType(c.base) ? data.rows.filter((r) => { const v = r[index.get(c.name) ?? -1]; return v !== null && v !== undefined && isInvalidDate(String(v)); }).length : 0;

      const defs = t.columns.map((c) => `"${c.rawName}" ${c.type}${sandboxNullable(c, datasetInvalid(c), invalidSource.get(`${t.name}.${c.name}`) ?? 0) ? '' : ' NOT NULL'}`);
      if (t.primaryKey.length > 0) defs.push(`CONSTRAINT "PK_${t.rawName}" PRIMARY KEY (${t.primaryKey.map((k) => `"${rawOf(t, k)}"`).join(', ')})`);
      await conn.execute(`CREATE TABLE "${t.rawName}" (${defs.join(', ')})`);

      const binds = data.rows.map((r) => t.columns.map((c) => toBind(c, index.has(c.name) ? r[index.get(c.name)!] : null, converted.get(c.name)!)));
      const placeholders = t.columns.map((c, i) => (isDateType(c.base) ? `TO_TIMESTAMP(:${i + 1}, 'YYYY-MM-DD HH24:MI:SS')` : `:${i + 1}`));
      const bindDefs = t.columns.map((_, i) => ({ type: oracledb.STRING, maxSize: Math.max(1, ...binds.map((b) => (b[i] ?? '').length)) }));
      let errors: { offset: number; code: number; message: string }[] = [];
      if (binds.length > 0) {
        const res = await conn.executeMany(
          `INSERT INTO "${t.rawName}" (${t.columns.map((c) => `"${c.rawName}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
          binds,
          { batchErrors: true, autoCommit: true, bindDefs },
        );
        errors = (res.batchErrors ?? []).map((e) => ({ offset: (e as { offset: number }).offset, code: ORA(e as { errorNum?: number }), message: e.message }));
      }
      const inserted = binds.length - errors.length;
      counts.push(`${t.name} ${inserted}/${data.rows.length}`);
      if (inserted !== data.rows.length) issues.row_count.push(`${t.name}: ${data.rows.length - inserted} linha(s) recusada(s) no sandbox`);
      for (const e of errors) {
        const msg = `${t.name} linha ${e.offset + 1}: ${e.message.split('\n')[0]}`;
        if (e.code === 12899) issues.silent_truncation.push(msg);
        else if (e.code === 1400) issues.null_count.push(msg);
        else issues.type_precision_scale.push(msg);
      }

      // nulos no sandbox = nulos do dataset + conversoes decididas no plano
      const nullSel = t.columns.map((c, i) => `SUM(CASE WHEN "${c.rawName}" IS NULL THEN 1 ELSE 0 END) AS "n${i}"`);
      const r = await conn.execute<Record<string, unknown>>(`SELECT ${nullSel.join(', ')} FROM "${t.rawName}"`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const row = r.rows?.[0] ?? {};
      const failed = new Set(errors.map((e) => e.offset));
      t.columns.forEach((c, i) => {
        const expected = data.rows.filter((rw, k) => !failed.has(k) && (rw[index.get(c.name) ?? -1] ?? null) === null).length + converted.get(c.name)!.n;
        const got = toIntOrNull(row[`n${i}`], 'nulls') ?? 0;
        if (got !== expected) issues.null_count.push(`${t.name}.${c.name}: ${got} nulo(s) no sandbox, esperado ${expected}`);
      });
    }

    // integridade referencial: orfaos no sandbox = orfaos na origem
    const dq = dialectFor(registry.source.engine);
    for (const t of loaded) {
      for (const fk of t.foreignKeys) {
        const parent = loaded.find((p) => p.name === fk.refTable);
        if (!parent || fk.columns.length !== 1) continue;
        const sql = orphanSql(t.rawName, rawOf(t, fk.columns[0]!), parent.rawName, rawOf(parent, fk.refColumns[0]!), (s) => `"${s}"`);
        const sbx = await conn.execute<Record<string, unknown>>(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const inSandbox = toInt(sbx.rows?.[0]?.n, 'orphans');
        const childCol = t.source?.columns.find((c) => c.name === fk.columns[0]);
        const parentCol = parent.source?.columns.find((c) => c.name === fk.refColumns[0]);
        let inSource = 0;
        if (t.source && parent.source && childCol && parentCol) {
          const srcSql = orphanSql(t.source.rawName, childCol.rawName, parent.source.rawName, parentCol.rawName, dq.quote);
          inSource = toInt((await registry.source.query(srcSql)).rows[0]?.n, 'orphans');
        }
        fkNotes.push(`${t.name}.${fk.columns[0]} -> ${fk.refTable}: ${inSandbox} orfao(s) no sandbox, ${inSource} na origem`);
        if (inSandbox !== inSource) issues.foreign_keys.push(`${t.name}.${fk.columns[0]}: ${inSandbox} orfao(s) no sandbox, ${inSource} na origem`);
      }
    }
  }));

  const checks: Check[] = [
    { name: 'row_count', passed: issues.row_count.length === 0, detail: counts.join(', ') || 'sem tabelas no dataset' },
    { name: 'silent_truncation', passed: issues.silent_truncation.length === 0, detail: issues.silent_truncation.join('; ') || 'nenhum valor excede o tipo planejado' },
    { name: 'foreign_keys', passed: issues.foreign_keys.length === 0, detail: fkNotes.join('; ') || 'sem FKs' },
    { name: 'type_precision_scale', passed: issues.type_precision_scale.length === 0, detail: issues.type_precision_scale.join('; ') || 'tipos, precisao e escala preservados' },
    { name: 'null_count', passed: issues.null_count.length === 0, detail: issues.null_count.join('; ') || 'nulos consistentes (incluindo conversoes decididas)' },
  ];
  return {
    valid: checks.every((c) => c.passed),
    checks,
    issues: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
    sandbox: { schema: sandbox.schema },
  };
}
