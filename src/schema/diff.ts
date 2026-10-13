import { classify, planProbe, Probe, ProbeRequest, Classification } from './classify';
import { NormColumn, NormSchema, NormTable, findColumn, findTable } from './types';

/** Executa os probes de uma tabela da origem (I/O fica fora do classificador). */
export interface ProbeRunner {
  run(table: NormTable, requests: Map<string, ProbeRequest>): Promise<Map<string, Probe>>;
}

type SideView = { database: string; type: string } & Partial<NormColumn>;

export interface DiffEntry {
  /** deterministico: tabela.coluna (repassavel direto ao /ai/analyze-conflict) */
  conflictId: string;
  table: string;
  column: string;
  classification: Classification;
  rules: string[];
  reason: string;
  warnings: string[];
  source: SideView;
  target: SideView;
  probe: Probe | null;
}

export interface DiffResult {
  summary: { tables: number; columns: number; mecanico: number; julgamento: number };
  conflicts: DiffEntry[];
}

const MISSING = 'AUSENTE';

/** CHECK (COL IN ('a','b')) restrito a uma coluna -> ['a','b'] */
export function checkInValues(table: NormTable, column: NormColumn): string[] | null {
  for (const ck of table.checks) {
    if (ck.columns.length !== 1 || ck.columns[0] !== column.name) continue;
    const m = /^\s*\(?\s*[`"]?[A-Za-z0-9_$#]+[`"]?\s+IN\s*\(([\s\S]*)\)\s*\)?\s*$/i.exec(ck.expression);
    if (!m) continue;
    const values: string[] = [];
    const re = /'((?:[^']|'')*)'/g;
    let v: RegExpExecArray | null;
    while ((v = re.exec(m[1] ?? '')) !== null) values.push((v[1] ?? '').replace(/''/g, "'"));
    return values;
  }
  return null;
}

const view = (engine: string, col: NormColumn): SideView => ({ database: engine, ...col });

function missing(table: string, column: string, srcEngine: string, tgtEngine: string, src: NormColumn | null, tgt: NormColumn | null, rule: string, reason: string): DiffEntry {
  return {
    conflictId: `${table}.${column}`,
    table,
    column,
    classification: 'julgamento',
    rules: [rule],
    reason,
    warnings: [],
    source: src ? view(srcEngine, src) : { database: srcEngine, type: MISSING },
    target: tgt ? view(tgtEngine, tgt) : { database: tgtEngine, type: MISSING },
    probe: null,
  };
}

export async function diffSchemas(source: NormSchema, target: NormSchema, runner: ProbeRunner): Promise<DiffResult> {
  const entries: DiffEntry[] = [];
  const tableNames = new Set([...source.tables.map((t) => t.name), ...target.tables.map((t) => t.name)]);

  for (const st of source.tables) {
    const tt = findTable(target, st.name);
    if (!tt) {
      entries.push(missing(st.name, '*', source.engine, target.engine, null, null, 'TABLE_MISSING_IN_TARGET', `tabela ${st.name} não existe no destino`));
      continue;
    }

    const pairs = st.columns.flatMap((sc) => {
      const tc = findColumn(tt, sc.name);
      return tc ? [{ sc, tc }] : [];
    });
    const requests = new Map<string, ProbeRequest>();
    for (const { sc, tc } of pairs) {
      const req = planProbe(sc, tc);
      if (Object.keys(req).length > 0) requests.set(sc.name, req);
    }
    const probes = requests.size > 0 ? await runner.run(st, requests) : new Map<string, Probe>();

    for (const sc of st.columns) {
      const tc = findColumn(tt, sc.name);
      if (!tc) {
        entries.push(missing(st.name, sc.name, source.engine, target.engine, sc, null, 'COLUMN_MISSING_IN_TARGET', `coluna ${st.name}.${sc.name} não existe no destino`));
        continue;
      }
      const probe = probes.get(sc.name) ?? null;
      const result = classify(sc, tc, probe, { targetCheckValues: checkInValues(tt, tc) });
      entries.push({
        conflictId: `${st.name}.${sc.name}`,
        table: st.name,
        column: sc.name,
        ...result,
        source: view(source.engine, sc),
        target: view(target.engine, tc),
        probe,
      });
    }
    for (const tc of tt.columns) {
      if (!findColumn(st, tc.name)) {
        entries.push(missing(st.name, tc.name, source.engine, target.engine, null, tc, 'COLUMN_MISSING_IN_SOURCE', `coluna ${st.name}.${tc.name} só existe no destino`));
      }
    }
  }
  for (const tt of target.tables) {
    if (!findTable(source, tt.name)) {
      entries.push(missing(tt.name, '*', source.engine, target.engine, null, null, 'TABLE_MISSING_IN_SOURCE', `tabela ${tt.name} só existe no destino`));
    }
  }

  return {
    summary: {
      tables: tableNames.size,
      columns: entries.filter((e) => e.column !== '*').length,
      mecanico: entries.filter((e) => e.classification === 'mecanico').length,
      julgamento: entries.filter((e) => e.classification === 'julgamento').length,
    },
    conflicts: entries,
  };
}
