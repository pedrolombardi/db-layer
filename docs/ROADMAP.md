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
- [x] 43 testes, CI + publicação da imagem, `docker compose` sem configuração manual, evidências reproduzíveis

## Fase 7 — prioridades

| Prio | Entrega | Por quê |
|---|---|---|
| P1 | **Autenticação entre serviços** (token por serviço) | Nenhum endpoint deveria ficar aberto fora da rede local |
| P1 | **Um schema de sandbox por migração** | Hoje as validações são serializadas, porque as tabelas do sandbox têm nomes fixos |
| P1 | **Amostragem e limite de tempo nos probes** | Ler a tabela inteira inviabiliza tabelas grandes de produção |
| P1 | **Credenciais por migração** (Connection Manager): hoje o DB Layer usa as conexões configuradas e recusa outras com 400 | O Core já envia host/database/usuário da origem |
| P1 | **Execução assistida do script** no destino, com carga dos dados e verificação pós-carga | Hoje o DB Layer gera o script e o DBA executa |
| P2 | **Amostragem estratificada** na extração (hoje: primeiras 1.000 linhas por PK) | A amostra precisa representar a tabela inteira |
| P2 | **Cache do catálogo** com expiração | Cada chamada de tool relê os dois catálogos hoje |
| P2 | **Regras novas**: string vazia vira NULL no Oracle (quebra `NOT NULL`); defaults; índices únicos com prefixo | Mais riscos que hoje passam em silêncio ficam visíveis |
| P2 | **Teste de usabilidade com desenvolvedores** que consomem a API (roteiro em USABILIDADE.md) | Medir o tempo até a primeira integração e onde a documentação trava |
| P3 | **Adaptador PostgreSQL** | Prova que a arquitetura de adaptadores escala para um terceiro banco |
| P3 | **Observabilidade**: logs estruturados (ex. `pino`) e métricas por probe | Diagnóstico em produção |
| P3 | **Gerenciador de segredos** no lugar das credenciais do compose | Exigência para qualquer ambiente fora do local |

## Decisões já tomadas (antes pendentes)

- **Quem entrega as linhas ao Data Layer:** o DB Layer, único com acesso de leitura à origem
  (`POST /extract/sample`, já no formato do `/v1/anonymize`).
- **`POST /plan/apply`:** gera o script de migração e **não** escreve no destino. A execução
  assistida, com carga e verificação pós-carga, é P1 da Fase 7.

## Fora do escopo do DB Layer

Escrita na origem ou no destino: o DB Layer só escreve no schema SANDBOX (validação). A carga no
destino depende da execução assistida (Fase 7), sempre depois da homologação humana.
Interface com o usuário: fica com o Front.
