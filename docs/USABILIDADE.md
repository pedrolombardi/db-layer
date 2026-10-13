# Teste de usabilidade — DB Layer

A Parte 5 da atividade avalia a **clareza da navegação** e a **facilidade de uso** do protótipo.
Ela é feita pelo grupo, sobre o protótipo navegável (Front-end). O DB Layer é um serviço sem
interface de usuário: não tem tela para navegar.

Nesta fase, a facilidade de uso do DB Layer para quem integra com ele está coberta assim:
- **Subir e usar sem ajuda:** README com o roteiro completo em bash e PowerShell; `docker compose up` sem configuração manual.
- **Consumo por outra parte do grupo:** o Backend Core real consumiu o DB Layer real sem alteração no código do Core ([evidência 9](evidencias/09-integracao-backend-core.json)).

Um teste com desenvolvedores que consomem a API fica para a Fase 7, com o roteiro abaixo.

## Roteiro previsto para a Fase 7 (≈ 15 min por pessoa)

A pessoa recebe só o repositório e o README, sem ajuda. Anotar o tempo e onde ela travou.

1. Subir o ambiente do zero (`docker compose up`) até o `/health/db` responder 200.
2. Rodar o diff e responder: *quantas colunas precisam de julgamento humano, e por quê?*
3. Pedir uma evidência de `clientes.email` e explicar o que o resultado significa.
4. Tentar o `sample-values` em `clientes.cpf` e explicar por que os valores não vieram.
