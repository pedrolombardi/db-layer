import { describe, it, expect } from 'vitest';
import { assertReadOnly } from '../src/db/readonly';
import { DbLayerError } from '../src/db/types';

/**
 * A regra "a origem e conectada em modo somente leitura" e estrutural.
 * Se estes testes passarem a falhar, a garantia deixou de existir.
 */
describe('assertReadOnly', () => {
  it('aceita statements de leitura', () => {
    expect(() => assertReadOnly('SELECT 1')).not.toThrow();
    expect(() => assertReadOnly('  select * from clientes  ')).not.toThrow();
    expect(() => assertReadOnly('WITH x AS (SELECT 1) SELECT * FROM x')).not.toThrow();
    expect(() => assertReadOnly('SHOW TABLES')).not.toThrow();
    expect(() => assertReadOnly('SELECT 1;')).not.toThrow();
  });

  it('recusa statements de escrita', () => {
    const escritas = [
      'INSERT INTO clientes (nome) VALUES ("x")',
      'UPDATE clientes SET ativo = 0',
      'DELETE FROM clientes',
      'DROP TABLE clientes',
      'TRUNCATE TABLE clientes',
      'ALTER TABLE clientes ADD COLUMN x INT',
      'CREATE TABLE t (id INT)',
      'GRANT ALL ON vendas.* TO x',
    ];
    for (const sql of escritas) {
      expect(() => assertReadOnly(sql), sql).toThrow(DbLayerError);
    }
  });

  it('recusa multiplos statements', () => {
    expect(() => assertReadOnly('SELECT 1; DROP TABLE clientes')).toThrow(
      /Multiplos statements/,
    );
  });

  it('nao se deixa enganar por comentario antes do verbo', () => {
    expect(() => assertReadOnly('/* SELECT */ DELETE FROM clientes')).toThrow(
      DbLayerError,
    );
    expect(() => assertReadOnly('-- SELECT\nUPDATE clientes SET ativo = 0')).toThrow(
      DbLayerError,
    );
  });

  it('recusa statement vazio', () => {
    expect(() => assertReadOnly('   ')).toThrow(DbLayerError);
    expect(() => assertReadOnly('-- so um comentario')).toThrow(DbLayerError);
  });
});
