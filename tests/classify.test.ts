import { describe, it, expect } from 'vitest';
import { classify, planProbe, Probe, ProbeRequest } from '../src/schema/classify';
import { diffSchemas, ProbeRunner } from '../src/schema/diff';
import { mysqlColumn, oracleColumn, parseEnumValues } from '../src/schema/introspect';
import { NormColumn, NormSchema, NormTable } from '../src/schema/types';
import seed from './fixtures/seed-schema.json';

/** Schema real introspectado do seed (MySQL 8.0 + Oracle 23ai Free). */
const source = seed.source as NormSchema;
const target = seed.target as NormSchema;

/** Probes que os INSERTs do seed produzem (conferidos no banco real). */
const SEED_PROBES: Record<string, Partial<Probe>> = {
  'clientes.email': { overflow: { unit: 'BYTE', limit: 200, valuesAbove: 2, maxObserved: 226 } },
  'clientes.cpf': { overflow: { unit: 'BYTE', limit: 11, valuesAbove: 0, maxObserved: 11 } },
  'clientes.ativo': { distinct: [{ value: 0, count: 1 }, { value: 1, count: 7 }, { value: 2, count: 2 }] },
  'pedidos.criado_em': { zeroDates: 2 },
};

const fakeRunner: ProbeRunner = {
  async run(table: NormTable, requests: Map<string, ProbeRequest>) {
    const out = new Map<string, Probe>();
    for (const [name, req] of requests) {
      const p: Probe = { totalRows: 10, ...SEED_PROBES[`${table.name}.${name}`] };
      if (req.zeroDate) p.zeroDates ??= 0;
      out.set(name, p);
    }
    return out;
  },
};

const col = (over: Partial<NormColumn>): NormColumn => ({
  name: 'c', rawName: 'c', position: 1, dataType: 'VARCHAR', type: 'VARCHAR(10)', length: 10,
  lengthSemantics: 'CHAR', precision: null, scale: null, nullable: false, autoIncrement: false,
  identityGeneration: null, onUpdateCurrentTimestamp: false, enumValues: null, charset: 'utf8mb4',
  collation: null, ...over,
});

describe('diff do seed (criterio de aceite)', () => {
  it('3 tabelas, 20 colunas: 15 mecanico / 5 julgamento', async () => {
    const r = await diffSchemas(source, target, fakeRunner);
    expect(r.summary).toEqual({ tables: 3, columns: 20, mecanico: 15, julgamento: 5 });
    const j = Object.fromEntries(
      r.conflicts.filter((c) => c.classification === 'julgamento').map((c) => [c.conflictId, c.rules]),
    );
    expect(j).toEqual({
      'clientes.email': ['LENGTH_NARROWING_OVERFLOW'],
      'clientes.ativo': ['TINYINT1_AMBIGUOUS'],
      'clientes.atualizado_em': ['ON_UPDATE_LOST'],
      'pedidos.criado_em': ['ZERO_DATE'],
      'eventos.dados': ['JSON_TO_CLOB'],
    });
  });

  it('o conflito sai no formato que o /ai/analyze-conflict aceita', async () => {
    const r = await diffSchemas(source, target, fakeRunner);
    const email = r.conflicts.find((c) => c.conflictId === 'clientes.email')!;
    expect(email).toMatchObject({
      table: 'clientes',
      column: 'email',
      source: { database: 'mysql', type: 'VARCHAR(300)' },
      target: { database: 'oracle', type: 'VARCHAR2(200)' },
    });
    expect(email.reason).toContain('máx. 226 > 200');
  });

  it('tabela ou coluna ausente vira julgamento com tipo AUSENTE (passa no validador da AI Layer)', async () => {
    const semEventos = { ...target, tables: target.tables.filter((t) => t.name !== 'eventos') };
    const r = await diffSchemas(source, semEventos, fakeRunner);
    const e = r.conflicts.find((c) => c.conflictId === 'eventos.*')!;
    expect(e.rules).toEqual(['TABLE_MISSING_IN_TARGET']);
    expect(e.target.type).toBe('AUSENTE');
  });
});

describe('classify (funcao pura)', () => {
  it('BYTE no destino exige probe em bytes; CHAR com folga nao', () => {
    const src = col({ type: 'VARCHAR(120)', length: 120 });
    expect(planProbe(src, col({ dataType: 'VARCHAR2', length: 120, lengthSemantics: 'CHAR' })).overflow).toBeUndefined();
    expect(planProbe(src, col({ dataType: 'VARCHAR2', length: 120, lengthSemantics: 'BYTE' })).overflow).toEqual({ unit: 'BYTE', limit: 120 });
    expect(planProbe(src, col({ dataType: 'VARCHAR2', length: 480, lengthSemantics: 'BYTE' })).overflow).toBeUndefined();
  });

  it('IDENTITY ALWAYS e julgamento (recusa os IDs explicitos da carga)', () => {
    const r = classify(
      col({ dataType: 'INT', type: 'INT', length: null, lengthSemantics: null, autoIncrement: true }),
      col({ dataType: 'NUMBER', type: 'NUMBER(10)', precision: 10, scale: 0, autoIncrement: true, identityGeneration: 'ALWAYS' }),
      null,
      { targetCheckValues: null },
    );
    expect(r.rules).toEqual(['IDENTITY_ALWAYS']);
  });

  it('ENUM sem CHECK no destino e julgamento', () => {
    const r = classify(
      col({ dataType: 'ENUM', type: "ENUM('a','b')", length: null, lengthSemantics: null, enumValues: ['a', 'b'] }),
      col({ dataType: 'VARCHAR2', type: 'VARCHAR2(10)', length: 10, lengthSemantics: 'BYTE' }),
      null,
      { targetCheckValues: null },
    );
    expect(r.rules).toEqual(['ENUM_WITHOUT_CHECK']);
  });

  it('nulos na origem com NOT NULL no destino e julgamento', () => {
    const r = classify(col({ nullable: true }), col({ dataType: 'VARCHAR2', length: 10 }), { totalRows: 5, nullCount: 1 }, { targetCheckValues: null });
    expect(r.rules).toEqual(['NULL_INTO_NOT_NULL']);
  });

  it('par sem regra cai no default conservador', () => {
    const r = classify(col({ dataType: 'GEOMETRY', type: 'GEOMETRY' }), col({ dataType: 'BLOB', type: 'BLOB' }), null, { targetCheckValues: null });
    expect(r.classification).toBe('julgamento');
    expect(r.rules).toEqual(['NO_RULE']);
  });
});

describe('normalizacao do catalogo', () => {
  it('MySQL: maiusculo, sem mexer nos rotulos do ENUM; ON UPDATE por includes', () => {
    const c = mysqlColumn({
      column_name: 'status', ordinal_position: 3, data_type: 'enum',
      column_type: "enum('novo','it''s')", is_nullable: 'NO', extra: '',
    });
    expect(c.type).toBe("ENUM('novo','it''s')");
    expect(c.enumValues).toEqual(['novo', "it's"]);
    const t = mysqlColumn({
      column_name: 'x', ordinal_position: '1', data_type: 'datetime', column_type: 'datetime',
      is_nullable: 'NO', extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP',
    });
    expect(t.onUpdateCurrentTimestamp).toBe(true);
    expect(parseEnumValues("enum('a')")).toEqual(['a']);
  });

  it('Oracle: BYTE sem sufixo, CHAR com sufixo, numeros que chegam como string', () => {
    const nls = { charset: 'AL32UTF8', ncharset: 'AL16UTF16' };
    const base = { COLUMN_NAME: 'EMAIL', COLUMN_ID: '3', NULLABLE: 'N', CHARACTER_SET_NAME: 'CHAR_CS' };
    expect(oracleColumn({ ...base, DATA_TYPE: 'VARCHAR2', DATA_LENGTH: '200', CHAR_LENGTH: '200', CHAR_USED: 'B' }, nls).type).toBe('VARCHAR2(200)');
    expect(oracleColumn({ ...base, DATA_TYPE: 'VARCHAR2', DATA_LENGTH: '480', CHAR_LENGTH: '120', CHAR_USED: 'C' }, nls).type).toBe('VARCHAR2(120 CHAR)');
    const n = oracleColumn({ ...base, DATA_TYPE: 'NUMBER', DATA_PRECISION: '18', DATA_SCALE: '4' }, nls);
    expect([n.type, n.precision, n.scale]).toEqual(['NUMBER(18,4)', 18, 4]);
    const ts = oracleColumn({ ...base, DATA_TYPE: 'TIMESTAMP(6)' }, nls);
    expect([ts.dataType, ts.precision]).toEqual(['TIMESTAMP', 6]);
  });
});
