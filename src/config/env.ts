import { z } from 'zod';

/**
 * Configuracao lida do ambiente. Credenciais nunca sao persistidas em codigo.
 * A validacao acontece no boot: e melhor o servico falhar barulhento ao subir
 * do que descobrir uma variavel faltando no meio de uma migracao.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  SRC_HOST: z.string().min(1),
  SRC_PORT: z.coerce.number().int().positive().default(3306),
  SRC_USER: z.string().min(1),
  SRC_PASSWORD: z.string(),
  SRC_DATABASE: z.string().min(1),

  TGT_HOST: z.string().min(1),
  TGT_PORT: z.coerce.number().int().positive().default(1521),
  TGT_SERVICE: z.string().min(1),
  TGT_USER: z.string().min(1),
  TGT_PASSWORD: z.string(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuracao invalida:\n${issues}`);
  }
  return parsed.data;
}
