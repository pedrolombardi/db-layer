# DB Layer

Microserviço responsável pela interação com os bancos de dados da plataforma de migração:
conexão com bancos heterogêneos, introspecção de schema, detecção de conflitos, execução das
consultas que servem de evidência para a AI Layer validação determinística dos planos de
migração.

**Regras estruturais do serviço:**

- a origem é conectada em **modo somente leitura** (garantido por `GRANT` no banco *e* por
  verificação no adaptador);
- **nenhum módulo — inclusive a AI Layer — aplica alteração em produção** sem homologação
  humana registrada;
- valores `NUMBER`/`DECIMAL`/`BIGINT` trafegam como **string**, nunca como `number` do
  JavaScript (o float64 não representa esses valores com fidelidade, e uma das verificações do
  serviço é justamente "precisão e escala preservadas").

## Requisitos

- Docker e Docker Compose
- Node.js 20+ (apenas para rodar fora do container)
- ~4 GB de RAM livres (o container do Oracle é pesado)

> **Mac com Apple Silicon:** a imagem `gvenzl/oracle-free:23-slim` tem versão `linux/arm64` e roda
> nativo no Docker Desktop.

## Subindo o ambiente

```bash
docker compose up --build        # nao precisa de .env
```

O primeiro boot do Oracle cria o banco, e os scripts de `seeds/` **só rodam no primeiro boot**.
Depois de mudar um seed, rode `docker compose down -v` (isso apaga os volumes).

## Desenvolvimento sem Docker para o serviço

Os bancos ficam no compose e o serviço roda no host:

```bash
docker compose up -d mysql oracle-free
cp .env.example .env               # aponta para localhost:3307 / localhost:1521
npm install
npm run dev                        # tsx watch, porta 3002
npm test && npm run typecheck && npm run lint && npm run build
```

## Endpoints (porta 3002)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | status do processo |
| GET | `/health/db` | conexão real nos dois lados (200/503, dizendo qual caiu) |
| POST | `/connections/test` | `{"role":"source"\|"target"}` → metadados de um lado. Formato do Backend Core `{source:{type,database,...}, target:{type}}` → `{source:{ok,readOnly,...}, target:{ok,...}}`; engine/database diferente do configurado → **400** `CONNECTION_MISMATCH` |
| GET | `/schema/introspect?side=source\|target` | modelo normalizado; um lado → `{side, engine, schema, tables}`, sem parâmetro → `{source, target}`. `?connection=` é sinônimo (usado pelo Core) |
| POST | `/schema/diff` | todas as colunas pareadas, `mecanico \| julgamento`, com regra e motivo |
| POST | `/extract/sample` | `{tables?, limit?}` → amostra da origem no formato do `/v1/anonymize` do Data Layer (datas, ENUM e flags em `options.preserve`) |
| POST | `/validate/plan` | `{plan, dataset}` → fatos da origem contra os tipos planejados + carga do dataset anonimizado no schema **SANDBOX** do Oracle: `row_count`, `silent_truncation`, `foreign_keys`, `type_precision_scale`, `null_count` |
| POST | `/plan/apply` | `{plan}` → **script de migração** para o destino (`applied: false`, `mode: "script"`): o DB Layer não escreve no destino |
| POST | `/tools/profile-column` | `{database, table, column, threshold?}` → tamanhos, nulos, quantos estouram |
| POST | `/tools/sample-values` | `{database, table, column, limit?}` → valores distintos e contagens. Coluna com muitos valores diferentes (CPF, e-mail) volta `masked: true`, sem os valores (LGPD) |
| POST | `/tools/check-charset` | `{database, table, column}` → charset, collation e bytes por caractere |

Tools: nome inválido (ex. `"clientes; DROP TABLE clientes"`) → **400** `INVALID_IDENTIFIER`, sem
nenhuma consulta. Nome válido, mas fora do catálogo → **200** `status: "NO_DATA"`.

Cada item do `/schema/diff` traz também os campos que o Backend Core valida (`id`, `kind`
`mechanical|judgement`, `sourceType`, `targetType`, `description` e, no mecânico, `resolution`).
O contrato do Core está coberto por `tests/core-contract.test.ts`.

## Evidências da PoC

`npm run evidencias` (com o compose de pé) chama cada endpoint nos bancos reais e salva as
respostas em `docs/evidencias/`, mais um `RESUMO.md`. A documentação da entrega está em [`docs/`](docs/).

## Roteiro da demo

**bash**
```bash
curl localhost:3002/health/db
curl -X POST localhost:3002/schema/diff
curl -X POST localhost:3002/tools/profile-column -H "content-type: application/json"   -d '{"database":"mysql","table":"clientes","column":"email"}'
curl -X POST localhost:3002/tools/profile-column -H "content-type: application/json"   -d '{"database":"mysql","table":"clientes; DROP TABLE clientes","column":"email"}'
npm run demo        # precisa da AI Layer na 3001
```

**PowerShell** (no 5.1, `curl` é `Invoke-WebRequest`; use `Invoke-RestMethod`)
```powershell
Invoke-RestMethod http://localhost:3002/health/db | ConvertTo-Json -Depth 5
(Invoke-RestMethod -Method Post http://localhost:3002/schema/diff).summary
$b = @{ database = "mysql"; table = "clientes"; column = "email" } | ConvertTo-Json
Invoke-RestMethod -Method Post http://localhost:3002/tools/profile-column -ContentType "application/json" -Body $b
$b = @{ database = "mysql"; table = "clientes; DROP TABLE clientes"; column = "email" } | ConvertTo-Json
try { Invoke-RestMethod -Method Post http://localhost:3002/tools/profile-column -ContentType "application/json" -Body $b } catch { $_.ErrorDetails.Message }
npm run demo
```

`npm run demo` chama o diff, manda cada conflito de julgamento para o `/ai/analyze-conflict` e
imprime `conflictId | regra | veredito | evidência`. A evidência mostrada é sempre a do DB Layer.
Se a AI Layer ainda estiver em mock, o veredito aparece marcado como `(AI simulada)`.
Para outras portas, use `DB_LAYER_URL` / `AI_LAYER_URL`.

## Os dados de exemplo

Os seeds não são genéricos: cada tabela carrega um conflito real de migração MySQL → Oracle.
É contra eles que o diff, as Tools e a validação serão exercitados.

| # | Onde                  | Conflito                                                        |
|---|-----------------------|-----------------------------------------------------------------|
| 1 | `clientes.email`      | `VARCHAR(300)` na origem, `VARCHAR2(200)` (BYTE) no destino — 2 registros excedem (216 e 226) |
| 2 | `clientes.ativo`      | `TINYINT(1)` que parece boolean, mas contém o valor `2`         |
| 3 | `clientes.id`         | `AUTO_INCREMENT` → `IDENTITY`                                    |
| 4 | `pedidos.status`      | `ENUM` (não existe no Oracle) → `VARCHAR2` + `CHECK`             |
| 5 | `pedidos.criado_em`   | `'0000-00-00 00:00:00'` — sem equivalente no Oracle              |
| 6 | `pedidos.observacao`  | `TEXT` → `CLOB`                                                  |
| 7 | `eventos.dados`       | `JSON` → `JSON` nativo (23ai) ou `CLOB`                          |
| 8 | `eventos.valor`       | `DOUBLE` → `BINARY_DOUBLE` ou `NUMBER`                           |

Resultado esperado do diff: **20 colunas → 15 mecânico / 5 julgamento** (`clientes.email`,
`clientes.ativo`, `clientes.atualizado_em`, `pedidos.criado_em`, `eventos.dados`).

O conflito 2 é o caso que o agente deve **deferir**: o valor `2` prova que a coluna não é
boolean, e o que ele significa não está no banco — só quem conhece a regra de negócio sabe.

## Estrutura

```
src/
  config/env.ts          configuração validada no boot (Zod)
  db/                    DbAdapter, guarda de somente-leitura, adaptadores mysql.ts e oracle.ts
  schema/                introspecção → modelo normalizado; classify (função pura); diff; probes
  tools/                 profile-column, sample-values, check-charset (allowlist + LGPD)
  routes/                health, connections, schema, tools
seeds/                   origem (MySQL) com os conflitos; destino (Oracle) propositalmente imperfeito
scripts/                 demo.ts (ponta a ponta com a AI Layer), evidencias.ts
tests/                   43 testes (Vitest + Supertest; contrato do Core em core-contract), fixture = schema real do seed
docs/                    entrega: evidências, validação técnica, arquitetura, usabilidade, roadmap
```

A lógica de domínio depende apenas de `DbAdapter`. Incluir suporte a um novo banco significa
escrever um novo adaptador, sem tocar no domínio.
