# Relatório de validação técnica — DB Layer

Escopo: o serviço que conecta aos bancos de origem e de destino, lê os catálogos, classifica os
conflitos de migração e fornece evidências à AI Layer. Tudo abaixo foi observado rodando contra
**MySQL 8.0 (origem) e Oracle Database 23ai Free (destino)** reais, via `docker compose`. As
saídas estão em [`evidencias/`](evidencias/RESUMO.md).

## 1. Viabilidade técnica

**Viável, e demonstrado.** As três hipóteses de maior risco foram confirmadas na prática:

| Hipótese | Resultado |
|---|---|
| Node.js consegue falar com o Oracle sem instalar cliente nativo | ✅ `oracledb` em modo *thin*: o container usa `node:22-slim` puro e o `/health/db` volta 200 |
| É possível separar o conflito **mecânico** (que o código resolve sozinho) do que exige **julgamento** com regras determinísticas | ✅ No seed: 20 colunas → **15 mecânico / 5 julgamento**, o resultado esperado conferido contra os dados inseridos |
| A IA pode receber evidência real **sem montar SQL** | ✅ As tools recebem só `{database, table, column}`; tabela e coluna são validadas contra o catálogo, e os valores vão por *bind* |

## 2. Desafios de implementação (encontrados e resolvidos)

| Desafio | Como apareceu | Solução |
|---|---|---|
| Seed do Oracle no schema errado | O script de inicialização da imagem roda como SYS no container raiz. As tabelas nasceriam fora do schema `VENDAS`, e o diff diria "falta tudo" sem erro nenhum | `ALTER SESSION SET CONTAINER/CURRENT_SCHEMA` + `WHENEVER SQLERROR EXIT FAILURE`. O diff também responde **503** se um lado vier sem tabela |
| Números chegando como texto | Para não perder precisão, os drivers devolvem `COUNT(*)` e tamanhos como `"200"`. A AI Layer compara `lengthThreshold === 200` e daria DEFER sem erro | Conversão na fronteira com checagem de inteiro seguro (falha alto) |
| Data zero (`0000-00-00`) | No modo estrito do MySQL, comparar com o literal dá erro, e a guarda de leitura não permite mudar o `sql_mode` | A verificação é feita pelo texto da data (`CAST(col AS CHAR)`) |
| Caractere × byte | `VARCHAR(n)` do MySQL conta caracteres; `VARCHAR2(n)` do Oracle conta bytes. Um e-mail acentuado cabe num e estoura no outro | O classificador mede na unidade do destino (bytes quando o destino é BYTE) |
| Erro de porta silencioso no Express 5 | O callback do `listen` passou a receber o erro, e com a porta ocupada o serviço dizia "ouvindo" sem escutar | O erro é tratado, e o processo encerra com mensagem |
| Brechas na guarda de somente-leitura | `WITH … DELETE`, `EXPLAIN ANALYZE DELETE` (que executa), `SELECT … INTO OUTFILE`, `/*! */` (comentário que o MySQL executa) e `1--1` passavam | Varredura que respeita aspas e procura efeitos colaterais **sem remover comentários** (na dúvida, recusa) + testes |
| Validação falsa | Um processo de desenvolvimento órfão continuou na porta 3002 e respondeu no lugar do container | Lição: conferir **qual processo** responde antes de dar algo como validado. A validação final foi refeita contra o container, do zero (`down -v`) |

### Integração com o Backend Core (validada)

O Backend Core do grupo (código do Giovanni, **sem alteração**) foi apontado para este DB Layer
real e montou a proposta: *"3 tabelas e 20 conflitos: 15 resolvidos por regra, …"*
([evidência 9](evidencias/09-integracao-backend-core.json)). Os formatos que o Core espera eram
suposição do lado dele. O DB Layer passou a aceitá-los **sem remover** os campos que já usava, e
`tests/core-contract.test.ts` trava esse contrato. A AI Layer e o Data Layer ainda eram mocks.

## 3. Riscos técnicos

| Risco | Impacto | Mitigação | Situação |
|---|---|---|---|
| Escrita acidental na origem (produção do cliente) | Crítico | Duas camadas: `GRANT SELECT` no banco + guarda no adaptador | ✅ mitigado |
| Injeção de SQL via parâmetro escolhido pela IA | Crítico | Sintaxe de identificador → **400**; allowlist do catálogo; valores por *bind* | ✅ mitigado |
| **LGPD**: dado pessoal (CPF, e-mail) chegando a um provedor de LLM | Alto | `sample-values` só devolve valores de colunas com poucos valores distintos (flags, status). As outras voltam `masked: true` | ✅ mitigado |
| API sem autenticação | Alto em produção | Fora do MVP; rede interna do compose | ⏳ Fase 7 |
| Credenciais de desenvolvimento no `docker-compose.yml` | Médio | Valem só para o ambiente local; em produção, gerenciador de segredos | ⏳ Fase 7 |
| Contrato com a AI Layer baseado em texto de tipo (`"VARCHAR2(200)"`) | Médio | O DB Layer renderiza o formato exato **e** envia os campos estruturados | ⚠️ a AI Layer precisa migrar |
| O Core envia as credenciais da origem por migração, mas o DB Layer usa as conexões configuradas nele | Alto: analisaria outro banco em silêncio | Engine e database diferentes do configurado → **400** `CONNECTION_MISMATCH` | ✅ mitigado; credencial por migração na Fase 7 |
| Mock da IA no Core contradiz o dado real: propõe `ativo` como booleano (0/1), mas existe o valor `2` | Alto, se o mock for apresentado como resultado | A AI Layer real (Erick) dá DEFER com a evidência do DB Layer | ⚠️ integrar a AI Layer real no Core |
| Origem e destino no mesmo engine (ex.: Oracle → Oracle) | Médio | Parâmetro opcional `side` nas tools | ✅ suportado |
| Ambiente pesado: Oracle Free usa ~2 GB de RAM | Baixo | Documentado; a imagem tem versão arm64 (Mac M) | ✅ |

## 4. Gargalos de performance e arquitetura

1. **Leitura da tabela inteira.** O diff e o `profile-column` usam `COUNT`/`MAX(LENGTH)` sobre a
   tabela toda. Com 10 linhas leva milissegundos; com centenas de milhões, cada probe vira uma
   leitura completa no banco de produção. → Amostragem (`TABLESAMPLE`/`SAMPLE`) com limite de
   tempo e grau de confiança no resultado.
2. **Catálogo relido a cada chamada.** Cada tool introspecta os dois bancos (≈ 4 consultas por
   lado). → Cache do catálogo com tempo de expiração e invalidação manual.
3. **Diff sequencial por tabela.** Uma consulta agregada por tabela, em série. → Paralelizar
   respeitando o tamanho do pool (hoje 4 conexões por lado).
4. **Serviço sem estado.** Não é gargalo, é o que permite escalar horizontalmente (ver
   [ARQUITETURA.md](ARQUITETURA.md)).

## 5. Ajustes no desenho da arquitetura

- **O classificador virou uma função pura.** A leitura do banco (introspecção e probes) fica
  separada da decisão `classify(origem, destino, probe)`. Isso permite testar sem banco e garante
  que quem valida não é quem propõe.
- **Modelo normalizado de schema** entre os bancos e o domínio. Um engine novo só precisa
  produzir esse modelo.
- **Contrato com a AI Layer**: o diff já devolve os conflitos de julgamento no formato do
  `/ai/analyze-conflict`, e as tools substituem os mocks sem mudar o contrato.
- **Porta 3002** (a 3001 é da AI Layer); o compose sobe sem configuração manual.

## 6. Qualidade

35 testes automatizados ([saída](evidencias/testes.txt)) cobrindo:
- o classificador, com o schema real do seed como fixture;
- a normalização dos catálogos;
- a guarda de somente-leitura;
- a injeção nas tools e o mascaramento por LGPD;
- as rotas, com bancos falsos.

O CI no GitHub Actions roda lint, typecheck, testes e build.
