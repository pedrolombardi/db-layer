# Evidências da PoC — DB Layer

Gerado por `npm run evidencias` em 2026-10-13T20:58:01.867Z contra http://localhost:3002
(bancos reais do `docker compose`: MySQL 8.0 e Oracle Database 23ai Free).

| # | Evidência | Requisição | HTTP | Destaque |
|---|---|---|---|---|
| 1 | Conexao real com origem (MySQL, somente leitura) e destino (Oracle) | `GET /health/db` | 200 | status "ok"; origem readOnly=true |
| 2 | Introspeccao normalizada dos dois catalogos | `GET /schema/introspect` | 200 | source: 3 tabelas; target: 3 tabelas |
| 3 | Diff classificado: mecanico x julgamento | `POST /schema/diff` | 200 | {"tables":3,"columns":20,"mecanico":15,"julgamento":5} — julgamento: clientes.email, clientes.ativo, clientes.atualizado_em, eventos.dados, pedidos.criado_em |
| 4 | Evidencia: e-mails que nao cabem no destino | `POST /tools/profile-column` | 200 | 2 de 10 acima de 200 BYTE; máx. 226 |
| 5 | Evidencia: valores distintos de clientes.ativo | `POST /tools/sample-values` | 200 | values [0,1,2] |
| 6 | Evidencia: charset da coluna de origem | `POST /tools/check-charset` | 200 | "utf8mb4" / "utf8mb4_0900_ai_ci" / 4 bytes por caractere |
| 7 | Seguranca: tentativa de injecao recusada sem executar consulta | `POST /tools/profile-column` | 400 | "INVALID_IDENTIFIER" |
| 8 | LGPD: coluna de alta cardinalidade (CPF) nao expoe valores | `POST /tools/sample-values` | 200 | masked=true, values [] |
