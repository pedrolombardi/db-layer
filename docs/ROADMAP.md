# Roadmap — DB Layer até o MVP final

## Já implementado (esta fase)

- [x] Conexão real com MySQL (origem, somente leitura em duas camadas) e Oracle 23ai (destino)
- [x] `GET /health/db`: diz qual lado caiu
- [x] `GET /schema/introspect`: catálogo dos dois bancos num modelo normalizado (tipos, tamanhos
  em CHAR/BYTE, PK, FK, CHECK, IDENTITY)
- [x] `POST /schema/diff`: 20 colunas → 15 mecânico / 5 julgamento, com regra, motivo e aviso
- [x] Tools de evidência para a AI Layer (`profile-column`, `sample-values`, `check-charset`)
  com dado real, protegidas contra injeção e com mascaramento LGPD
- [x] Integração com a AI Layer comprovada ponta a ponta (`npm run demo`)
- [x] Integração com o Backend Core comprovada: o Core real consome o DB Layer real (contrato coberto por teste)
- [x] Análise real de ponta a ponta: Core + AI Layer + DB Layer reais (evidência 10)
- [x] Execução real: extração → Data Layer → validação no sandbox Oracle (5 verificações) → script de migração
- [x] Plataforma completa (`placeholder-platform`): um `docker compose up` com todos os serviços e o front, mais o e2e no CI
- [x] 30 testes, CI, `docker compose` sem configuração manual, evidências reproduzíveis

## Fase 7 — prioridades

| Prio | Entrega | Por quê |
|---|---|---|
| P1 | **Autenticação entre serviços** (token por serviço) | Nenhum endpoint deveria ficar aberto fora da rede local |
| P1 | **Amostragem e limite de tempo nos probes** | Ler a tabela inteira inviabiliza tabelas grandes de produção |
| P1 | **Credenciais por migração** (Connection Manager): hoje o DB Layer usa as conexões configuradas e recusa outras com 400 | O Core já envia host/database/usuário da origem |
| P1 | **Execução assistida do script** no destino, com carga dos dados e verificação pós-carga | Hoje o DB Layer gera o script e o DBA executa |
| P2 | **Amostragem estratificada** na extração (hoje: primeiras 1.000 linhas por PK) | A amostra precisa representar a tabela inteira |
| — | ~~Extração de amostra para o Data Layer~~ (feito) (`POST /extract/sample` → `{dataset: {tables: [{name, columns: [{name, type, nullable, pk, fk}], rows}]}}`, o formato do `/v1/anonymize` do Lucas) | O Data Layer recebe linhas mas não lê a origem, e hoje ninguém as entrega; o DB Layer é o único com acesso de leitura. Exige combinar o tipo de `DECIMAL` (string, para não perder precisão) e o limite de linhas |
| P2 | **Cache do catálogo** com expiração | Cada chamada de tool relê os dois catálogos hoje |
| P2 | **Regras novas**: string vazia vira NULL no Oracle (quebra `NOT NULL`); defaults; índices únicos com prefixo | Mais riscos que hoje passam em silêncio ficam visíveis |
| P2 | **Imagem no GHCR** (workflow pronto) | O grupo roda sem precisar buildar |
| P2 | **Teste de usabilidade com desenvolvedores** que consomem a API (roteiro em USABILIDADE.md) | Medir o tempo até a primeira integração e onde a documentação trava |
| P3 | **Adaptador PostgreSQL** | Prova que a arquitetura de adaptadores escala para um terceiro banco |
| P3 | **Observabilidade**: logs estruturados (ex. `pino`) e métricas por probe | Diagnóstico em produção |
| P3 | **Gerenciador de segredos** no lugar das credenciais do compose | Exigência para qualquer ambiente fora do local |

## Decisão pendente no grupo

O Core chama `POST /plan/apply` (escrita no destino), que **não está** no documento da Fase 6.
O próprio README do Core marca a rota como suposição. Escrever no destino depois da homologação
pede uma decisão explícita do grupo sobre quem escreve e com que garantias. Até lá, o DB Layer não
escreve em banco nenhum.

Também pendente: quem entrega as linhas ao Data Layer. O Core chama `POST /anonymize` só com credenciais e nomes de tabela, mas o Data Layer (`/v1/anonymize`) espera receber as linhas. A proposta é o DB Layer extrair a amostra (item P1 acima).

## Fora do escopo do DB Layer

Escrita em qualquer banco: a carga é feita depois da homologação humana, por outro componente.
Interface com o usuário: fica com o Front.
