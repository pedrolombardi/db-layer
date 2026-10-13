import { NormColumn, NormSchema, NormTable, findColumn, findTable } from '../schema/types';

/**
 * Plano aprovado (proposta do Backend Core depois da homologacao) traduzido
 * para o que o DB Layer executa: o tipo e a nulabilidade planejados de cada
 * coluna do destino, e o que fazer com valores invalidos. FUNCOES PURAS.
 */

/** Conflito como vem na proposta do Core (campos extras sao ignorados). */
export interface PlanConflict {
  id: string;
  table: string;
  column: string;
  decidedBy?: string | null;
  status?: string;
  resolution?: string;
}

export interface PlannedColumn {
  name: string;
  rawName: string;
  /** tipo Oracle planejado, ja reconstruido a partir de partes validadas */
  type: string;
  base: string;
  length: number | null;
  semantics: 'CHAR' | 'BYTE' | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  /** tipo declarado hoje no destino, quando o plano o altera */
  changedFrom: string | null;
  /** decisao humana/IA: datas invalidas viram NULL ou uma data padrao */
  onInvalid: { kind: 'null' } | { kind: 'default'; value: string } | null;
  autoIncrement: boolean;
  source: NormColumn | null;
  conflict: PlanConflict | null;
}

export interface PlannedTable {
  name: string;
  rawName: string;
  columns: PlannedColumn[];
  primaryKey: string[];
  foreignKeys: NormTable['foreignKeys'];
  source: NormTable | null;
}

/**
 * Tipo Oracle citado numa resolucao em texto livre ("Usar VARCHAR2(300 CHAR)").
 * O texto vem de fora (IA/humano) e vai parar num DDL: so aceita a gramatica
 * abaixo e RECONSTROI o tipo a partir das partes, nunca copia o texto.
 */
export function parseOracleType(text: string): Pick<PlannedColumn, 'type' | 'base' | 'length' | 'semantics' | 'precision' | 'scale'> | null {
  const t = text.toUpperCase();
  let m = /\b(VARCHAR2|NVARCHAR2|NCHAR|CHAR)\s*\(\s*(\d{1,5})\s*(CHAR|BYTE)?\s*\)/.exec(t);
  if (m) {
    const base = m[1]!;
    const length = Number(m[2]);
    const national = base.startsWith('N');
    const semantics = national || m[3] === 'CHAR' ? 'CHAR' : 'BYTE';
    return { base, length, semantics, precision: null, scale: null, type: `${base}(${length}${semantics === 'CHAR' && !national ? ' CHAR' : ''})` };
  }
  m = /\bNUMBER\s*\(\s*(\d{1,2})\s*(?:,\s*(\d{1,2})\s*)?\)/.exec(t);
  if (m) {
    const precision = Number(m[1]);
    const scale = m[2] !== undefined ? Number(m[2]) : 0;
    return { base: 'NUMBER', length: null, semantics: null, precision, scale, type: scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})` };
  }
  m = /\b(CLOB|NCLOB|BINARY_DOUBLE|BINARY_FLOAT|BOOLEAN|DATE)\b/.exec(t);
  if (m) return { base: m[1]!, length: null, semantics: null, precision: null, scale: null, type: m[1]! };
  m = /\bTIMESTAMP(?:\s*\(\s*(\d)\s*\))?/.exec(t);
  if (m) {
    const p = m[1] !== undefined ? Number(m[1]) : 6;
    return { base: 'TIMESTAMP', length: null, semantics: null, precision: p, scale: null, type: `TIMESTAMP(${p})` };
  }
  return null;
}

/** Decisao sobre valores invalidos citada na resolucao: "... para NULL" ou uma data padrao. */
export function parseOnInvalid(text: string): PlannedColumn['onInvalid'] {
  const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (date && date[1] !== '0000-00-00') return { kind: 'default', value: date[1]! };
  if (/\bNULL\b/i.test(text) && !/\bNOT\s+NULL\b/i.test(text)) return { kind: 'null' };
  return null;
}

function fromTarget(col: NormColumn) {
  return {
    type: col.type,
    base: col.dataType,
    length: col.length,
    semantics: col.lengthSemantics,
    precision: col.precision,
    scale: col.scale,
  };
}

/** Destino declarado + decisoes do plano = o que o sandbox cria e o script altera. */
export function planTables(source: NormSchema, target: NormSchema, conflicts: PlanConflict[]): PlannedTable[] {
  const byId = new Map(conflicts.map((c) => [`${c.table.toLowerCase()}.${c.column.toLowerCase()}`, c]));
  return target.tables.map((tt) => {
    const st = findTable(source, tt.name) ?? null;
    const columns = tt.columns.map((tc): PlannedColumn => {
      const conflict = byId.get(`${tt.name}.${tc.name}`) ?? null;
      const decided = conflict && (conflict.decidedBy === 'ai' || conflict.decidedBy === 'human') && conflict.resolution;
      const parsed = decided ? parseOracleType(conflict.resolution!) : null;
      const planned = parsed ?? fromTarget(tc);
      return {
        name: tc.name,
        rawName: tc.rawName,
        ...planned,
        nullable: tc.nullable,
        changedFrom: parsed && parsed.type !== tc.type ? tc.type : null,
        onInvalid: decided ? parseOnInvalid(conflict.resolution!) : null,
        autoIncrement: tc.autoIncrement,
        source: st ? (findColumn(st, tc.name) ?? null) : null,
        conflict,
      };
    });
    return { name: tt.name, rawName: tt.rawName, columns, primaryKey: tt.primaryKey, foreignKeys: tt.foreignKeys, source: st };
  });
}

/** Pais antes dos filhos (ordem de carga e de criacao das FKs). */
export function loadOrder(tables: PlannedTable[]): PlannedTable[] {
  const done = new Set<string>();
  const out: PlannedTable[] = [];
  const visit = (t: PlannedTable, stack: Set<string>) => {
    if (done.has(t.name) || stack.has(t.name)) return;
    stack.add(t.name);
    for (const fk of t.foreignKeys) {
      const parent = tables.find((p) => p.name === fk.refTable);
      if (parent && parent.name !== t.name) visit(parent, stack);
    }
    done.add(t.name);
    out.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return out;
}

export const isDateType = (base: string) => base === 'DATE' || base.startsWith('TIMESTAMP');

/** '0000-00-00...' ou mes/dia zero: sem equivalente no Oracle. */
export function isInvalidDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return true;
  return Number(m[1]) === 0 || Number(m[2]) === 0 || Number(m[3]) === 0;
}

const q = (id: string) => `"${id}"`;

/**
 * Script de migracao para o destino, a partir do plano aprovado e validado.
 * O DB Layer GERA o script e nao o executa: aplicar em producao e um passo
 * explicito do DBA (Fase 7: execucao assistida).
 */
export function migrationScript(
  targetSchema: string,
  tables: PlannedTable[],
  invalidDatesBySource: Map<string, number>,
  meta: { generatedAt: string },
): { script: string; statements: number } {
  const lines: string[] = [
    `-- Script de migracao gerado pelo DB Layer em ${meta.generatedAt}`,
    `-- Destino: schema ${targetSchema}. Plano aprovado por homologacao humana e validado no sandbox.`,
    '-- NAO executado pelo DB Layer: revisar e aplicar pelo DBA.',
    '',
  ];
  let statements = 0;
  const after: string[] = [];
  const suggestions: string[] = [];

  for (const t of tables) {
    for (const c of t.columns) {
      const target = `${q(targetSchema)}.${q(t.rawName)}`;
      if (c.changedFrom) {
        lines.push(`-- ${t.name}.${c.name}: ${c.changedFrom} -> ${c.type} (${c.conflict?.decidedBy === 'human' ? 'decisao humana' : 'proposta da IA aprovada'})`);
        lines.push(`ALTER TABLE ${target} MODIFY (${q(c.rawName)} ${c.type});`);
        statements++;
      }
      const invalid = invalidDatesBySource.get(`${t.name}.${c.name}`) ?? 0;
      if (c.onInvalid?.kind === 'null' && invalid > 0 && !c.nullable) {
        lines.push(`-- ${t.name}.${c.name}: ${invalid} data(s) invalida(s) na origem viram NULL (decisao humana)`);
        lines.push(`ALTER TABLE ${target} MODIFY (${q(c.rawName)} NULL);`);
        statements++;
      }
      if (c.onInvalid?.kind === 'default' && invalid > 0) {
        lines.push(`-- ${t.name}.${c.name}: ${invalid} data(s) invalida(s) na origem viram ${c.onInvalid.value} na carga (decisao humana)`);
      }
      if (c.autoIncrement) {
        after.push(`ALTER TABLE ${target} MODIFY (${q(c.rawName)} GENERATED BY DEFAULT AS IDENTITY (START WITH LIMIT VALUE));`);
      }
      if (c.source?.onUpdateCurrentTimestamp) {
        suggestions.push(
          `-- ${t.name}.${c.name} tinha ON UPDATE CURRENT_TIMESTAMP no MySQL. Sugestao:`,
          `-- CREATE OR REPLACE TRIGGER ${q(targetSchema)}.${q(`TRG_${t.rawName}_${c.rawName}`.slice(0, 128))}`,
          `--   BEFORE UPDATE ON ${target} FOR EACH ROW BEGIN :NEW.${q(c.rawName)} := SYSTIMESTAMP; END;`,
        );
      }
    }
  }
  if (statements === 0) lines.push('-- (nenhuma alteracao de estrutura no destino)');
  if (after.length > 0) {
    lines.push('', '-- Depois da carga dos dados: ressincronizar as colunas IDENTITY', ...after);
    statements += after.length;
  }
  if (suggestions.length > 0) lines.push('', ...suggestions);
  return { script: lines.join('\n') + '\n', statements };
}
