# DB Layer

Microserviço responsável pela interação com os bancos de dados da plataforma de migração:
conexão com bancos heterogêneos, introspecção de schema, detecção de conflitos, execução das
consultas que servem de evidência para a AI Layer e validação determinística dos planos de
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

> **Mac com Apple Silicon (M1/M2/M3/M4):** o Oracle Database não roda nativamente em ARM.
> As alternativas são rodar sob emulação x86 (lento, mas funciona — Docker Desktop com Rosetta,
> ou Colima com `--arch x86_64`) ou apontar `TGT_*` para uma instância Oracle remota
> (por exemplo, a do OCI). Verifique isso **antes** de perder tempo depurando o container.

## Subindo o ambiente

```bash
cp .env.example .env
docker compose up
```

O primeiro boot do Oracle leva alguns minutos — ele cria o banco do zero. Os boots seguintes
reaproveitam o volume e são rápidos. Acompanhe com:

```bash
docker compose logs -f oracle-free
```

Quando tudo estiver de pé:

```bash
curl localhost:3001/health          # liveness — não toca nos bancos
curl localhost:3001/health/db       # readiness — abre conexão REAL nos dois
```

`GET /health/db` responde `200` quando os dois lados conectam e `503` quando algum falha,
sempre indicando **qual** lado e por quê.

## Desenvolvimento sem Docker

```bash
npm install
npm run dev        # tsx watch
npm test           # vitest
npm run typecheck
npm run lint
npm run build
```

## Endpoints

| Método | Rota                  | Descrição                                        |
|--------|-----------------------|--------------------------------------------------|
| GET    | `/health`             | status do processo                                |
| GET    | `/health/db`          | abre conexão real na origem e no destino          |
| POST   | `/connections/test`   | metadados da conexão (`{"role":"source"\|"target"}`) |

Planejados (próxima etapa): `/schema/introspect`, `/schema/diff`, `/tools/*`, `/validate/plan`.

## Os dados de exemplo

Os seeds não são genéricos: cada tabela carrega um conflito real de migração MySQL → Oracle.
É contra eles que o diff, as Tools e a validação serão exercitados.

| # | Onde                  | Conflito                                                        |
|---|-----------------------|-----------------------------------------------------------------|
| 1 | `clientes.email`      | `VARCHAR(300)` na origem, `VARCHAR2(200 CHAR)` no destino — 2 registros excedem |
| 2 | `clientes.ativo`      | `TINYINT(1)` que parece boolean, mas contém o valor `2`         |
| 3 | `clientes.id`         | `AUTO_INCREMENT` → `IDENTITY`                                    |
| 4 | `pedidos.status`      | `ENUM` (não existe no Oracle) → `VARCHAR2` + `CHECK`             |
| 5 | `pedidos.criado_em`   | `'0000-00-00 00:00:00'` — sem equivalente no Oracle              |
| 6 | `pedidos.observacao`  | `TEXT` → `CLOB`                                                  |
| 7 | `eventos.dados`       | `JSON` → `JSON` nativo (23ai) ou `CLOB`                          |
| 8 | `eventos.valor`       | `DOUBLE` → `BINARY_DOUBLE` ou `NUMBER`                           |

O conflito 2 é o caso que o agente deve **deferir**: o valor `2` prova que a coluna não é
boolean, e o que ele significa não está no banco — só quem conhece a regra de negócio sabe.

## Estrutura

```
src/
  config/env.ts          configuração validada no boot (Zod)
  db/
    types.ts             interface comum dos adaptadores
    readonly.ts          guarda de somente-leitura
    registry.ts          instancia origem e destino
    adapters/            mysql.ts, oracle.ts
  routes/                health.ts, connections.ts
seeds/
  mysql/                 schema de origem com os conflitos
  oracle/                schema de destino (propositalmente imperfeito)
tests/
```

A lógica de domínio depende apenas de `DbAdapter`. Incluir suporte a um novo banco significa
escrever um novo adaptador, sem tocar no domínio.
