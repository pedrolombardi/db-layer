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
- [x] 30 testes, CI, `docker compose` sem configuração manual, evidências reproduzíveis

## Fase 7 — prioridades

| Prio | Entrega | Por quê |
|---|---|---|
| P1 | **Autenticação entre serviços** (token por serviço) | Nenhum endpoint deveria ficar aberto fora da rede local |
| P1 | **Amostragem e limite de tempo nos probes** | Ler a tabela inteira inviabiliza tabelas grandes de produção |
| P1 | **`/validate/plan`**: validar deterministicamente o plano de migração | É o "quem valida não é quem propõe" aplicado ao plano. Depende de acertar o formato do plano com o Core |
| P2 | **Cache do catálogo** com expiração | Cada chamada de tool relê os dois catálogos hoje |
| P2 | **Regras novas**: string vazia vira NULL no Oracle (quebra `NOT NULL`); defaults; índices únicos com prefixo | Mais riscos que hoje passam em silêncio ficam visíveis |
| P2 | **Imagem no GHCR** (workflow pronto) | O grupo roda sem precisar buildar |
| P3 | **Adaptador PostgreSQL** | Prova que a arquitetura de adaptadores escala para um terceiro banco |
| P3 | **Observabilidade**: logs estruturados (ex. `pino`) e métricas por probe | Diagnóstico em produção |
| P3 | **Gerenciador de segredos** no lugar das credenciais do compose | Exigência para qualquer ambiente fora do local |

## Fora do escopo do DB Layer

Escrita em qualquer banco: a carga é feita depois da homologação humana, por outro componente.
Interface com o usuário: fica com o Front.
