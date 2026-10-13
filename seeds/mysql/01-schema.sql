-- ---------------------------------------------------------------------------
-- Banco de ORIGEM (MySQL 8) — schema `vendas`
--
-- O schema e proposital: cada tabela carrega pelo menos um conflito real de
-- migracao MySQL -> Oracle. E contra estes dados que o /schema/diff, as Tools
-- de evidencia e a validacao deterministica serao exercitados.
-- ---------------------------------------------------------------------------

-- MySQL 8 recusa datas zero em modo estrito (NO_ZERO_DATE / NO_ZERO_IN_DATE).
-- Bancos legados estao cheios delas, e reproduzir isso e o objetivo aqui.
SET SESSION sql_mode = '';

-- O cliente do entrypoint roda sem locale (latin1): sem isto "João" vira "JoÃ£o".
SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS vendas
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE vendas;

-- ---------------------------------------------------------------------------
-- clientes
--   CONFLITO 1  email VARCHAR(300) -> destino declarado VARCHAR2(200).
--               5% dos valores excedem 200 caracteres.
--   CONFLITO 2  ativo TINYINT(1): parece boolean, mas contem o valor 2.
--   CONFLITO 3  id AUTO_INCREMENT -> IDENTITY/sequence no Oracle.
-- ---------------------------------------------------------------------------
CREATE TABLE clientes (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  nome           VARCHAR(120)  NOT NULL,
  email          VARCHAR(300)  NOT NULL,
  cpf            CHAR(11)      NULL,
  ativo          TINYINT(1)    NOT NULL DEFAULT 1,
  saldo          DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
  criado_em      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_clientes_email (email(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- pedidos
--   CONFLITO 4  status ENUM -> Oracle nao tem ENUM (VARCHAR2 + CHECK).
--   CONFLITO 5  criado_em com '0000-00-00 00:00:00' — sem equivalente no Oracle.
--   CONFLITO 6  observacao TEXT -> CLOB.
-- ---------------------------------------------------------------------------
CREATE TABLE pedidos (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  cliente_id  INT NOT NULL,
  status      ENUM('novo','pago','enviado','cancelado') NOT NULL DEFAULT 'novo',
  total       DECIMAL(18,4) NOT NULL,
  observacao  TEXT NULL,
  criado_em   DATETIME NOT NULL,
  CONSTRAINT fk_pedidos_cliente
    FOREIGN KEY (cliente_id) REFERENCES clientes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- eventos
--   CONFLITO 7  dados JSON -> JSON nativo (23ai) ou CLOB.
--   CONFLITO 8  valor DOUBLE -> BINARY_DOUBLE ou NUMBER (precisao).
-- ---------------------------------------------------------------------------
CREATE TABLE eventos (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  pedido_id  INT NOT NULL,
  tipo       VARCHAR(60) NOT NULL,
  dados      JSON NULL,
  valor      DOUBLE NULL,
  ocorrido_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_eventos_pedido
    FOREIGN KEY (pedido_id) REFERENCES pedidos (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Carga
-- ---------------------------------------------------------------------------

-- clientes "normais"
INSERT INTO clientes (nome, email, cpf, ativo, saldo, criado_em) VALUES
  ('Ana Souza',      'ana.souza@example.com',      '12345678901', 1, 1520.5000, '2024-03-11 10:00:00'),
  ('Bruno Lima',     'bruno.lima@example.com',     '23456789012', 0,    0.0000, '2024-04-02 14:22:00'),
  ('Carla Menezes',  'carla.menezes@example.com',  '34567890123', 1,  340.7500, '2024-05-19 09:10:00'),
  ('Diego Nunes',    'diego.nunes@example.com',    NULL,          1,   88.2500, '2024-06-01 16:45:00');

-- CONFLITO 2: o valor 2 prova que `ativo` NAO e boolean.
-- Sem documentacao, ninguem sabe o que 2 significa — e por isso que o agente
-- deve DEFERIR este conflito em vez de inventar um mapeamento.
INSERT INTO clientes (nome, email, cpf, ativo, saldo, criado_em) VALUES
  ('Eduardo Prado',  'eduardo.prado@example.com',  '45678901234', 2,   12.0000, '2024-06-14 08:30:00'),
  ('Fernanda Rocha', 'fernanda.rocha@example.com', '56789012345', 2,    0.0000, '2024-07-03 11:05:00');

-- CONFLITO 1: e-mails com mais de 200 caracteres.
INSERT INTO clientes (nome, email, cpf, ativo, saldo, criado_em) VALUES
  ('Contas a Pagar Matriz',
   CONCAT(REPEAT('contato.financeiro.matriz.zona.sul.contas.a.pagar.', 4), '2024@example.com'),
   NULL, 1, 0.0000, '2024-07-21 13:00:00'),
  ('Integrador Marketplace',
   CONCAT(REPEAT('no-reply.notificacoes.pedidos.marketplace.integrador.', 4), 'v2@example.com'),
   NULL, 1, 0.0000, '2024-08-02 17:30:00');

-- acentuacao: em VARCHAR2(n BYTE) um caractere acentuado ocupa mais de 1 byte.
INSERT INTO clientes (nome, email, cpf, ativo, saldo, criado_em) VALUES
  ('João Gonçalves',    'joao.goncalves@example.com',    '67890123456', 1, 45.9000, '2024-08-15 10:20:00'),
  ('Conceição Araújo',  'conceicao.araujo@example.com',  '78901234567', 1, 77.1000, '2024-08-28 12:40:00');

INSERT INTO pedidos (cliente_id, status, total, observacao, criado_em) VALUES
  (1, 'pago',      250.0000, 'entrega expressa',        '2024-06-10 10:00:00'),
  (1, 'enviado',   120.5000, NULL,                      '2024-06-12 11:30:00'),
  (2, 'cancelado',  80.0000, 'cliente desistiu',        '2024-06-15 09:00:00'),
  (3, 'novo',      412.9000, NULL,                      '2024-07-01 14:00:00');

-- CONFLITO 5: data zero, tipica de migracao anterior mal feita.
INSERT INTO pedidos (cliente_id, status, total, observacao, criado_em) VALUES
  (4, 'pago',       99.9900, 'importado do sistema antigo', '0000-00-00 00:00:00'),
  (5, 'novo',       10.0000, NULL,                          '0000-00-00 00:00:00');

INSERT INTO eventos (pedido_id, tipo, dados, valor) VALUES
  (1, 'pagamento_aprovado', '{"gateway":"stone","nsu":"884211"}', 250.00),
  (1, 'nota_emitida',       '{"nfe":"35240912345678000199"}',     NULL),
  (2, 'despacho',           '{"transportadora":"correios"}',      120.50),
  (3, 'cancelamento',       '{"motivo":"desistencia"}',           NULL);

-- Usuario SOMENTE LEITURA usado pelo DB Layer para a origem.
-- A regra "a origem e conectada em modo somente leitura" comeca aqui, no GRANT.
CREATE USER IF NOT EXISTS 'readonly'@'%' IDENTIFIED BY 'readonly';
GRANT SELECT ON vendas.* TO 'readonly'@'%';
FLUSH PRIVILEGES;
