import { DbLayerError } from './types';

/**
 * Segunda barreira de somente-leitura.
 *
 * A primeira e a permissao do usuario no proprio banco (o usuario da origem so
 * tem GRANT de SELECT). Esta aqui existe porque uma credencial mal provisionada
 * nao pode ser o unico obstaculo entre a plataforma e uma escrita acidental na
 * origem — a regra "a origem e conectada em modo somente leitura" e estrutural,
 * entao vale a redundancia.
 *
 * Nao pretende ser um parser de SQL: e uma checagem conservadora que recusa
 * qualquer statement que nao comece por um verbo de leitura conhecido, alem de
 * barrar multiplos statements na mesma chamada.
 */

const ALLOWED_PREFIXES = ['select', 'with', 'show', 'describe', 'desc', 'explain'];

export function assertReadOnly(sql: string): void {
  const normalized = stripComments(sql).trim().toLowerCase();

  if (normalized.length === 0) {
    throw new DbLayerError('READ_ONLY_VIOLATION', 'Statement vazio');
  }

  // multiplos statements: recusa "SELECT 1; DROP TABLE x"
  const withoutTrailing = normalized.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new DbLayerError(
      'READ_ONLY_VIOLATION',
      'Multiplos statements nao sao permitidos em conexao de origem',
    );
  }

  const startsWithReadVerb = ALLOWED_PREFIXES.some(
    (p) => withoutTrailing === p || withoutTrailing.startsWith(`${p} `) || withoutTrailing.startsWith(`${p}\n`),
  );

  if (!startsWithReadVerb) {
    throw new DbLayerError(
      'READ_ONLY_VIOLATION',
      'A conexao de origem aceita apenas statements de leitura',
    );
  }
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* ... */
    .replace(/--[^\n]*/g, ' '); // -- ...
}
