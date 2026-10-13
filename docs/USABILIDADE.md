# Teste de usabilidade — DB Layer

Os usuários do DB Layer são **desenvolvedores**: quem consome a API (AI Layer, Core, Front) e quem
precisa subir o ambiente. Por isso o teste mede a experiência de quem integra: clareza da
documentação, facilidade para subir o ambiente e para entender as respostas.

## Roteiro (≈ 15 min por pessoa)

A pessoa recebe só o repositório e o README, sem ajuda. Anotar o tempo e onde ela travou.

1. Subir o ambiente do zero (`docker compose up`) até o `/health/db` responder 200.
2. Rodar o diff e responder: *quantas colunas precisam de julgamento humano, e por quê?*
3. Pedir uma evidência de `clientes.email` e explicar o que o resultado significa.
4. Tentar o `sample-values` em `clientes.cpf` e explicar por que os valores não vieram.

## Registro

| | Usuário 1 | Usuário 2 |
|---|---|---|
| Nome / papel | | |
| Sistema (Windows / Mac / Linux) | | |
| Tempo até o `/health/db` 200 | | |
| Concluiu as tarefas 2–4? | | |
| Onde travou | | |
| Clareza da navegação (README/API), 1–5 | | |
| Facilidade de uso, 1–5 | | |
| Feedback (nas palavras da pessoa) | | |

## Melhorias identificadas

| Melhoria | Origem (usuário) | Prioridade | Situação |
|---|---|---|---|
| | | | |
