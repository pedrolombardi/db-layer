/**
 * Os drivers devolvem inteiros como string de proposito (bigNumberStrings no
 * mysql2, fetchAsString de NUMBER no oracledb): COUNT(*), LENGTH() e o
 * catalogo (DATA_LENGTH...) chegam como "10", "226", "200".
 *
 * Contagens e tamanhos cabem com folga em Number, e o contrato com a AI Layer
 * usa number (o Erick compara `lengthThreshold === 200`). A conversao acontece
 * aqui, na fronteira, e falha alto se o valor nao for um inteiro seguro.
 */
export function toInt(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new Error(`Esperava inteiro seguro em ${what}, veio ${JSON.stringify(value)}`);
}

export function toIntOrNull(value: unknown, what: string): number | null {
  return value === null || value === undefined ? null : toInt(value, what);
}
