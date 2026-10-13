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

  it('fecha escrita disfarcada de leitura', () => {
    const disfarcadas = [
      'WITH x AS (SELECT 1) DELETE FROM clientes', // MySQL 8 aceita
      'EXPLAIN ANALYZE DELETE FROM clientes', // EXPLAIN ANALYZE executa
      "SELECT * FROM clientes INTO OUTFILE '/tmp/x'",
      'SELECT * FROM clientes FOR UPDATE',
      "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */", // comentario executavel
      "SELECT 1--1 INTO OUTFILE '/tmp/x'", // no MySQL 1--1 e conta, nao comentario
      "SELECT `a#b` INTO OUTFILE '/tmp/x' FROM t", // # dentro de identificador
    ];
    for (const sql of disfarcadas) {
      expect(() => assertReadOnly(sql), sql).toThrow(DbLayerError);
    }
  });

  it('nao confunde literal ou identificador citado com escrita', () => {
    expect(() => assertReadOnly("SELECT 'update' AS x FROM t")).not.toThrow();
    expect(() => assertReadOnly('SELECT `delete`, "INTO" FROM t')).not.toThrow();
    expect(() => assertReadOnly('SHOW CREATE TABLE clientes')).not.toThrow();
    expect(() => assertReadOnly("WITH x AS (SELECT 'drop' AS v) SELECT v FROM x")).not.toThrow();
  });

  it('recusa statement vazio', () => {
    expect(() => assertReadOnly('   ')).toThrow(DbLayerError);
    expect(() => assertReadOnly('-- so um comentario')).toThrow(DbLayerError);
  });
});
