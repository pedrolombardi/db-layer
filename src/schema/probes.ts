import { DbAdapter } from '../db/types';
import { Probe, ProbeRequest } from './classify';
import { ProbeRunner } from './diff';
import { dialectFor } from './dialect';
import { toInt, toIntOrNull } from './num';
import { NormTable, findColumn } from './types';

/**
 * Probes de dados na ORIGEM, uma consulta agregada por tabela (mais uma por
 * coluna que precisa dos valores distintos). Somente SELECT: passa pelo
 * assertReadOnly do adapter.
 */
export function sqlProbeRunner(db: DbAdapter): ProbeRunner {
  const d = dialectFor(db.engine);
  return {
    async run(table: NormTable, requests: Map<string, ProbeRequest>) {
      const select = [`COUNT(*) AS ${d.quote('total')}`];
      const params: unknown[] = [];
      const plan: { name: string; i: number; req: ProbeRequest; overflow: boolean }[] = [];

      [...requests].forEach(([name, req], i) => {
        const col = findColumn(table, name);
        if (!col) throw new Error(`probe: coluna fora do catalogo: ${table.name}.${name}`);
        const q = d.quote(col.rawName);
        if (req.zeroDate && db.engine === 'mysql') {
          // Por texto: em sql_mode estrito, comparar com '0000-00-00' vira
          // erro/warning, e o assertReadOnly nao deixa trocar o sql_mode.
          const txt = `CAST(${q} AS CHAR)`;
          select.push(
            `SUM(CASE WHEN ${txt} LIKE '0000-%' OR SUBSTRING(${txt}, 6, 2) = '00' OR SUBSTRING(${txt}, 9, 2) = '00' THEN 1 ELSE 0 END) AS ${d.quote(`z${i}`)}`,
          );
        }
        if (req.nulls) select.push(`SUM(CASE WHEN ${q} IS NULL THEN 1 ELSE 0 END) AS ${d.quote(`n${i}`)}`);
        let overflow = false;
        if (req.overflow) {
          const len = (req.overflow.unit === 'BYTE' ? d.byteLength(q, col) : null) ?? d.charLength(q, col);
          params.push(req.overflow.limit);
          select.push(`SUM(CASE WHEN ${len} > ${d.param(params.length)} THEN 1 ELSE 0 END) AS ${d.quote(`o${i}`)}`);
          select.push(`MAX(${len}) AS ${d.quote(`m${i}`)}`);
          overflow = true;
        }
        plan.push({ name, i, req, overflow });
      });

      const res = await db.query(`SELECT ${select.join(', ')} FROM ${d.quote(table.rawName)}`, params);
      const row = res.rows[0] ?? {};
      const totalRows = toInt(row.total, 'COUNT(*)');
      const out = new Map<string, Probe>();

      for (const { name, i, req, overflow } of plan) {
        const probe: Probe = { totalRows };
        if (req.zeroDate) probe.zeroDates = toIntOrNull(row[`z${i}`], 'zeroDates') ?? 0;
        if (req.nulls) probe.nullCount = toIntOrNull(row[`n${i}`], 'nullCount') ?? 0;
        if (overflow && req.overflow) {
          probe.overflow = {
            ...req.overflow,
            valuesAbove: toIntOrNull(row[`o${i}`], 'valuesAbove') ?? 0,
            maxObserved: toIntOrNull(row[`m${i}`], 'maxObserved'),
          };
        }
        if (req.distinct) {
          const col = findColumn(table, name)!;
          const q = d.quote(col.rawName);
          const r = await db.query(
            d.limit(`SELECT ${q} AS ${d.quote('v')}, COUNT(*) AS ${d.quote('n')} FROM ${d.quote(table.rawName)} GROUP BY ${q} ORDER BY ${q}`, 101),
          );
          probe.distinct = r.rows.map((x) => ({ value: x.v, count: toInt(x.n, 'COUNT(*)') }));
        }
        out.set(name, probe);
      }
      return out;
    },
  };
}
