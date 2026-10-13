# Arquitetura — DB Layer (atualizada após a PoC)

## Visão na plataforma

```mermaid
flowchart LR
  U([Usuário]) --> FE[Front-end React]
  FE --> CORE[Core / orquestração]
  CORE -->|POST /schema/diff| DBL
  CORE -->|POST /ai/analyze-conflict| AI[AI Layer<br/>regras + LLM]
  AI -->|POST /tools/*<br/>só table/column| DBL

  subgraph DBL[DB Layer :3002 — TypeScript / Express 5]
    R[Rotas + validação Zod] --> D[Domínio]
    D --> A[DbAdapter]
  end

  A -->|mysql2 · SOMENTE LEITURA<br/>GRANT SELECT + guarda| SRC[(MySQL 8<br/>ORIGEM)]
  A -->|oracledb thin<br/>sem Instant Client| TGT[(Oracle Database 23ai<br/>DESTINO)]
```

Na PoC, o papel do Core é feito pelo `npm run demo`: ele chama o diff e manda cada conflito de
julgamento à AI Layer. As integrações com MySQL e Oracle são **reais** (containers
`mysql:8.0` e `gvenzl/oracle-free:23-slim`).

## Dentro do DB Layer

```mermaid
flowchart TB
  subgraph IO[Entrada e saída de banco]
    INT[introspect<br/>catálogo → modelo normalizado]
    PRB[probes<br/>agregados na origem]
    TLS[tools<br/>profile · sample · charset]
  end
  subgraph PURE[Código determinístico, sem acesso a banco]
    CLS[classify<br/>mecânico × julgamento]
    DIF[diff<br/>pareia origem × destino]
  end
  INT --> DIF
  PRB --> DIF
  DIF --> CLS
  TLS -->|1 sintaxe → 400<br/>2 allowlist do catálogo → NO_DATA<br/>3 valores por bind| ADP[DbAdapter<br/>MySqlAdapter · OracleAdapter]
  INT --> ADP
  PRB --> ADP
  ADP --> RO{{assertReadOnly<br/>na origem}}
```

### Decisões tomadas na prática

| Decisão | Por quê |
|---|---|
| `oracledb` em modo *thin* | Sem Oracle Instant Client: imagem pequena, roda igual em Windows, Linux e Mac |
| `NUMBER`/`DECIMAL`/`BIGINT` trafegam como texto, contagens convertidas na fronteira | O número do JavaScript perde precisão, e o contrato com a AI Layer precisa de `number` |
| Classificador como função pura | Testável com fixtures; quem valida não é quem propõe |
| Modelo normalizado (`NormSchema`) | O domínio não conhece driver; um engine novo é só um adaptador novo |
| Identificador validado contra o catálogo, nunca vindo pronto de fora | A IA escolhe **qual** evidência quer, nunca **como** consultar |
| Mascaramento por cardinalidade no `sample-values` | Dado pessoal não sai do DB Layer em direção ao LLM |

## Como suporta crescimento

- **Novos bancos**: implementar `DbAdapter` + uma função de introspecção que produza
  `NormSchema`. O diff, o classificador e as tools não mudam. O PostgreSQL é o próximo.
- **Novas regras de migração**: cada regra é um caso em `classify()`, uma função pura com teste
  próprio. Regra nova não exige banco para ser testada.
- **Novos consumidores** (Core, Front, AI Layer): contrato HTTP/JSON estável, com códigos de
  erro fixos (`INVALID_IDENTIFIER`, `EMPTY_SCHEMA`, `NO_DATA`...).

## Escalabilidade

- **Serviço sem estado**: não guarda sessão nem resultado. Dá pra subir N réplicas atrás de um
  balanceador.
- **Pool de conexões por lado** (hoje 4, configurável). Quem limita o volume é o banco de
  origem, não o serviço. Por isso o roadmap prevê amostragem e limite de tempo nos probes.
- **O trabalho pesado fica no banco**: os probes são agregados (`COUNT`, `MAX`, `SUM CASE`), e
  o que trafega são números, não linhas.

## Manutenção

- **TypeScript estrito**, com configuração validada no boot (falha alto se faltar variável).
- **30 testes** + CI (lint, typecheck, testes e build) a cada push. O workflow que publica a
  imagem no GHCR está escrito, mas ainda não rodou (falta o repositório no GitHub).
- **Reprodutível**: `docker compose up` sobe origem, destino e serviço sem configuração manual;
  `npm run evidencias` regera as evidências.
