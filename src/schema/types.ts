/**
 * Modelo normalizado de schema: o que a introspeccao de qualquer engine produz
 * e o que o diff/classificador consomem. Nomes em minusculo para casar
 * origem x destino; `rawName` guarda o identificador como esta no catalogo.
 */

export type Side = 'source' | 'target';

export interface NormColumn {
  name: string;
  rawName: string;
  position: number;
  /** tipo base: VARCHAR, TINYINT, VARCHAR2, NUMBER, TIMESTAMP... */
  dataType: string;
  /** renderizado: "VARCHAR(300)", "TINYINT(1)", "VARCHAR2(200)", "VARCHAR2(120 CHAR)" */
  type: string;
  length: number | null;
  lengthSemantics: 'CHAR' | 'BYTE' | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  /** MySQL AUTO_INCREMENT | Oracle IDENTITY */
  autoIncrement: boolean;
  /** so Oracle: ALWAYS recusa ID explicito na carga */
  identityGeneration: 'ALWAYS' | 'BY DEFAULT' | null;
  /** so MySQL */
  onUpdateCurrentTimestamp: boolean;
  enumValues: string[] | null;
  charset: string | null;
  collation: string | null;
}

export interface NormTable {
  name: string;
  rawName: string;
  columns: NormColumn[];
  primaryKey: string[];
  foreignKeys: { name: string; columns: string[]; refTable: string; refColumns: string[] }[];
  checks: { name: string; columns: string[]; expression: string }[];
}

export interface NormSchema {
  engine: 'mysql' | 'oracle';
  schema: string;
  tables: NormTable[];
}

export function findTable(schema: NormSchema, name: string): NormTable | undefined {
  const key = name.toLowerCase();
  return schema.tables.find((t) => t.name === key);
}

export function findColumn(table: NormTable, name: string): NormColumn | undefined {
  const key = name.toLowerCase();
  return table.columns.find((c) => c.name === key);
}
