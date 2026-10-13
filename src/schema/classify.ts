import { NormColumn } from './types';

/**
 * Classificador: FUNCAO PURA. Nao toca em banco; recebe as duas colunas e o
 * resultado dos probes e decide `mecanico | julgamento`. Quem valida nunca e
 * quem propos: esta regra e codigo deterministico e testado com fixtures.
 */

export type Classification = 'mecanico' | 'julgamento';

/** O que o classificador precisa medir nos dados da origem. */
export interface ProbeRequest {
  zeroDate?: boolean;
  nulls?: boolean;
  distinct?: boolean;
  overflow?: { unit: 'CHAR' | 'BYTE'; limit: number };
}

export interface Probe {
  totalRows: number;
  zeroDates?: number;
  nullCount?: number;
  distinct?: { value: unknown; count: number }[];
  overflow?: { unit: 'CHAR' | 'BYTE'; limit: number; valuesAbove: number; maxObserved: number | null };
}

export interface ClassifyContext {
  /** valores permitidos por um CHECK (col IN (...)) no destino, se houver */
  targetCheckValues: string[] | null;
}

export interface ClassifyResult {
  classification: Classification;
  rules: string[];
  reason: string;
  warnings: string[];
}

const INT_DIGITS: Record<string, number> = {
  TINYINT: 3, SMALLINT: 5, MEDIUMINT: 8, INT: 10, INTEGER: 10, BIGINT: 19,
};
const DATES = new Set(['DATETIME', 'TIMESTAMP', 'DATE']);
const TEXTS = new Set(['TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT']);
const ORA_STRINGS = new Set(['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR']);
const MYSQL_MAX_BYTES: Record<string, number> = { utf8mb4: 4, utf8mb3: 3, utf8: 3, latin1: 1, ascii: 1 };

function maxBytesPerChar(col: NormColumn): number {
  return (col.charset && MYSQL_MAX_BYTES[col.charset.toLowerCase()]) || 4;
}

const isTinyBool = (c: NormColumn) => c.dataType === 'TINYINT' && /^TINYINT\(1\)/.test(c.type);

/**
 * Comparacao de tamanho na unidade do DESTINO: VARCHAR(n) do MySQL conta
 * caractere; VARCHAR2(m) BYTE conta byte. So da para dispensar o probe se o
 * pior caso cabe (m >= n em CHAR; m >= n * bytes/char em BYTE).
 */
function overflowRequest(src: NormColumn, tgt: NormColumn): ProbeRequest['overflow'] | undefined {
  if (tgt.length === null || !ORA_STRINGS.has(tgt.dataType)) return undefined;
  const srcIsString = src.lengthSemantics !== null || TEXTS.has(src.dataType);
  if (!srcIsString) return undefined;
  const unit = tgt.lengthSemantics ?? 'CHAR';
  if (src.length !== null) {
    const worst = unit === 'CHAR' ? src.length : src.length * maxBytesPerChar(src);
    if (tgt.length >= worst) return undefined;
  }
  return { unit, limit: tgt.length };
}

export function planProbe(src: NormColumn, tgt: NormColumn): ProbeRequest {
  const req: ProbeRequest = {};
  if (DATES.has(src.dataType)) req.zeroDate = true;
  if (src.nullable && !tgt.nullable) req.nulls = true;
  if (isTinyBool(src)) req.distinct = true;
  const overflow = overflowRequest(src, tgt);
  if (overflow) req.overflow = overflow;
  return req;
}

type Judgment = { rule: string; reason: string };

function typeRule(src: NormColumn, tgt: NormColumn, ctx: ClassifyContext, probe: Probe | null, warnings: string[]): Judgment | null {
  const S = src.dataType;
  const T = tgt.dataType;

  if (isTinyBool(src)) {
    const d = probe?.distinct;
    const evidence = d ? `; distintos: ${d.map((x) => `${String(x.value)} (${x.count}×)`).join(', ')}` : '';
    return { rule: 'TINYINT1_AMBIGUOUS', reason: `TINYINT(1) parece booleano, mas o significado é regra de negócio${evidence}` };
  }

  const digits = INT_DIGITS[S];
  if (digits !== undefined) {
    const need = S === 'BIGINT' && /UNSIGNED/.test(src.type) ? 20 : digits;
    if (T === 'NUMBER' && (tgt.scale ?? 0) === 0) {
      if (tgt.precision === null || tgt.precision >= need) return null;
      return { rule: 'NUMERIC_NARROWING', reason: `${src.type} precisa de ${need} dígitos; destino ${tgt.type}` };
    }
  }

  if ((S === 'DECIMAL' || S === 'NUMERIC') && T === 'NUMBER') {
    const p = src.precision ?? 10;
    const s = src.scale ?? 0;
    if (tgt.precision === null && tgt.scale === null && p <= 38) return null;
    const tp = tgt.precision ?? 38;
    const ts = tgt.scale ?? 0;
    if (tp - ts >= p - s && ts >= s) return null;
    return { rule: 'NUMERIC_NARROWING', reason: `${src.type} não cabe em ${tgt.type} sem perder dígitos` };
  }

  if (S === 'DOUBLE' && T === 'BINARY_DOUBLE') return null;
  if (S === 'FLOAT' && (T === 'BINARY_FLOAT' || T === 'BINARY_DOUBLE')) return null;
  if (S === 'CHAR' && (T === 'CHAR' || T === 'NCHAR')) return null;
  if (S === 'VARCHAR' && (T === 'VARCHAR2' || T === 'NVARCHAR2')) return null;
  if (TEXTS.has(S) && (T === 'CLOB' || T === 'NCLOB')) return null;

  if (S === 'ENUM' && ORA_STRINGS.has(T)) {
    const labels = src.enumValues ?? [];
    const size = (l: string) => (tgt.lengthSemantics === 'BYTE' ? Buffer.byteLength(l, 'utf8') : [...l].length);
    const longest = Math.max(0, ...labels.map(size));
    const fits = tgt.length !== null && tgt.length >= longest;
    const allowed = ctx.targetCheckValues;
    const covered = allowed !== null && labels.every((l) => allowed.includes(l));
    if (fits && covered) return null;
    const why = [!covered && 'sem CHECK cobrindo todos os rótulos', !fits && `tamanho ${tgt.length} < maior rótulo (${longest})`]
      .filter(Boolean)
      .join('; ');
    return { rule: 'ENUM_WITHOUT_CHECK', reason: `ENUM → ${tgt.type}: ${why}` };
  }

  if (S === 'DATETIME' && T === 'TIMESTAMP') return null;
  if (S === 'DATE' && T === 'DATE') return null;
  if (S === 'TIMESTAMP' && (T === 'TIMESTAMP' || T === 'TIMESTAMP WITH LOCAL TIME ZONE')) {
    if (T === 'TIMESTAMP') {
      warnings.push("TIMESTAMP do MySQL é guardado em UTC e convertido pelo time_zone da sessão: extrair com time_zone fixo (ex. '+00:00')");
    }
    return null;
  }

  if (S === 'JSON' && (T === 'CLOB' || T === 'NCLOB')) {
    return { rule: 'JSON_TO_CLOB', reason: 'JSON → CLOB perde a validação de JSON; o 23ai tem tipo JSON nativo — decisão de design' };
  }
  if (S === 'JSON' && T === 'JSON') return null;

  return { rule: 'NO_RULE', reason: `sem regra conhecida para ${src.type} → ${tgt.type} (default conservador)` };
}

export function classify(src: NormColumn, tgt: NormColumn, probe: Probe | null, ctx: ClassifyContext): ClassifyResult {
  const warnings: string[] = [];
  const judgments: Judgment[] = [];

  const t = typeRule(src, tgt, ctx, probe, warnings);
  if (t) judgments.push(t);

  if (src.autoIncrement) {
    if (!tgt.autoIncrement) {
      judgments.push({ rule: 'AUTO_INCREMENT_LOST', reason: 'AUTO_INCREMENT na origem; destino sem IDENTITY' });
    } else if (tgt.identityGeneration === 'ALWAYS') {
      judgments.push({ rule: 'IDENTITY_ALWAYS', reason: 'IDENTITY GENERATED ALWAYS recusa os IDs explícitos da carga (as FKs dependem deles)' });
    } else {
      warnings.push('ressincronizar a IDENTITY depois da carga (START WITH LIMIT VALUE)');
    }
  }

  if (src.onUpdateCurrentTimestamp) {
    judgments.push({ rule: 'ON_UPDATE_LOST', reason: 'ON UPDATE CURRENT_TIMESTAMP não existe no Oracle: o comportamento se perde em silêncio sem trigger' });
  }

  if (probe?.zeroDates) {
    judgments.push({ rule: 'ZERO_DATE', reason: `${probe.zeroDates} de ${probe.totalRows} linhas com data zero ou parcial (sem equivalente no Oracle)` });
  }

  const o = probe?.overflow;
  if (o) {
    const unit = o.unit === 'BYTE' ? ' bytes' : '';
    if (o.valuesAbove > 0) {
      judgments.push({
        rule: 'LENGTH_NARROWING_OVERFLOW',
        reason: `${o.valuesAbove} valores excedem o tamanho declarado no destino (máx. ${o.maxObserved} > ${o.limit}${unit})`,
      });
    } else {
      warnings.push(`destino menor que o pior caso da origem (${tgt.type}), mas os dados atuais cabem (máx. ${o.maxObserved ?? 0}${unit})`);
    }
  }

  if (probe?.nullCount) {
    judgments.push({ rule: 'NULL_INTO_NOT_NULL', reason: `${probe.nullCount} nulos na origem; destino é NOT NULL` });
  }

  if (judgments.length > 0) {
    return {
      classification: 'julgamento',
      rules: judgments.map((j) => j.rule),
      reason: judgments.map((j) => j.reason).join('; '),
      warnings,
    };
  }
  return {
    classification: 'mecanico',
    rules: [],
    reason: `equivalência direta ${src.type} → ${tgt.type}`,
    warnings,
  };
}
