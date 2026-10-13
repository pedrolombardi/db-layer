# Entrega — DB Layer (Pedro)

Mapa de cada parte da atividade para os arquivos desta pasta.

| Parte da atividade | Onde está |
|---|---|
| 1. Protótipo (parcial funcional, back-end) | O próprio serviço. O fluxo principal (conectar → ler catálogos → classificar → evidência) está no [roteiro do README](../README.md#roteiro-da-demo) |
| 2. Prova de conceito + integração com banco | [evidencias/RESUMO.md](evidencias/RESUMO.md): respostas reais de MySQL 8 e Oracle 23ai. Código em [`../src`](../src) |
| 3. Validação técnica | [VALIDACAO_TECNICA.md](VALIDACAO_TECNICA.md) |
| 4. Arquitetura atualizada | [ARQUITETURA.md](ARQUITETURA.md) (diagramas em Mermaid; [arquitetura.png](arquitetura.png) e [arquitetura-interna.png](arquitetura-interna.png) para quem não renderiza Mermaid) |
| 5. Teste de usabilidade | [USABILIDADE.md](USABILIDADE.md) (roteiro + registro) |
| 6. Roadmap | [ROADMAP.md](ROADMAP.md) |

Para regenerar as evidências: `docker compose up -d` e depois `npm run evidencias`.
