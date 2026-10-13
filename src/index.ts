import { loadEnv } from './config/env';
import { createRegistry } from './db/registry';
import { createApp } from './app';

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = createRegistry(env);

  // Nao aborta o boot se um banco estiver fora do ar: o servico sobe e o
  // /health/db reporta o estado. Em desenvolvimento e comum a API subir antes
  // do Oracle terminar de inicializar.
  try {
    await registry.connectAll();
    console.log('[db-layer] pools abertos (origem e destino)');
  } catch (err) {
    console.error('[db-layer] falha ao abrir pools no boot:', (err as Error).message);
    console.error('[db-layer] o servico vai subir; consulte GET /health/db');
  }

  const app = createApp(registry);
  // Express 5: erros do listen (ex.: EADDRINUSE) chegam neste callback.
  // Ignorar o argumento deixaria o processo de pe sem escutar - falha silenciosa.
  const server = app.listen(env.PORT, (err?: Error) => {
    if (err) {
      console.error(`[db-layer] nao consegui escutar na porta ${env.PORT}:`, err.message);
      void registry.closeAll().finally(() => process.exit(1));
      return;
    }
    console.log(`[db-layer] ouvindo na porta ${env.PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[db-layer] ${signal} recebido, encerrando`);
    server.close();
    await registry.closeAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[db-layer] erro fatal no boot:', err);
  process.exit(1);
});
