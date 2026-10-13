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
 * Nao pretende ser um parser de SQL: e uma checagem conservadora (na duvida,
 * recusa) que exige um verbo de leitura no inicio, barra multiplos statements
 * e fecha os caminhos conhecidos de escrita "por dentro" de uma leitura.
 */

const ALLOWED_PREFIXES = ['select', 'with', 'show', 'describe', 'desc', 'explain'];

/** WITH ... DELETE (MySQL 8) e EXPLAIN ANALYZE DELETE (que EXECUTA) */
const WRITE_VERBS = /\b(insert|update|delete|replace|merge|upsert|truncate|drop|alter|create|grant|revoke|call|load|rename|set|lock|handler|do)\b/;

/** escrita/lock disfarcados de SELECT */
const SELECT_SIDE_EFFECTS = /\binto\b|\bfor\s+update\b|\bfor\s+share\b|\block\s+in\s+share\s+mode\b/;

export function assertReadOnly(sql: string): void {
  // /*! ... */ e comentario que o MySQL EXECUTA: nao da para so remover.
  if (/\/\*!/.test(sql)) {
    throw new DbLayerError('READ_ONLY_VIOLATION', 'Comentario executavel (/*! */) nao e permitido');
  }

  const normalized = neutralize(sql, true).trim().toLowerCase();

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

  const verb = ALLOWED_PREFIXES.find(
    (p) => withoutTrailing === p || new RegExp(`^${p}\\s`).test(withoutTrailing),
  );
  if (!verb) {
    throw new DbLayerError(
      'READ_ONLY_VIOLATION',
      'A conexao de origem aceita apenas statements de leitura',
    );
  }

  // Efeitos colaterais: varre o texto COM os comentarios (remover comentario
  // pode esconder codigo: no MySQL "1--1" e conta, nao comentario). Literais e
  // identificadores citados nao contam: coluna `update` ou texto 'delete' nao
  // sao escrita.
  const code = neutralize(sql, false).toLowerCase();

  if (verb === 'select' && SELECT_SIDE_EFFECTS.test(code)) {
    throw new DbLayerError('READ_ONLY_VIOLATION', 'SELECT com efeito colateral (INTO / FOR UPDATE) nao e permitido');
  }
  if (verb !== 'select' && verb !== 'show' && WRITE_VERBS.test(code)) {
    throw new DbLayerError('READ_ONLY_VIOLATION', `Verbo de escrita dentro de ${verb.toUpperCase()} nao e permitido`);
  }
}

/** literal | identificador citado | comentario, nessa prioridade, da esquerda para a direita */
const TOKEN = /'(?:[^'\\]|''|\\.)*'|`[^`]*`|"[^"]*"|\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*/g;

function neutralize(sql: string, dropComments: boolean): string {
  return sql.replace(TOKEN, (m) => {
    if (m.startsWith("'")) return "''";
    if (m.startsWith('`')) return '``';
    if (m.startsWith('"')) return '""';
    return dropComments ? ' ' : m;
  });
}
