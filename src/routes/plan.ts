import { Router } from 'express';
import { z } from 'zod';
import { Registry } from '../db/registry';
import { Deps } from '../deps';
import { extractSample } from '../plan/extract';
import { loadOrder, migrationScript, planTables } from '../plan/model';
import { sourceFacts, validatePlan } from '../plan/validate';
import { parseBody } from '../http';

const conflictSchema = z
  .object({
    id: z.string().min(1),
    table: z.string().min(1),
    column: z.string().min(1),
    decidedBy: z.string().nullable().optional(),
    status: z.string().optional(),
    resolution: z.string().optional(),
  })
  .passthrough();
const planSchema = z.object({ conflicts: z.array(conflictSchema) }).passthrough();

const extractSchema = z
  .object({ tables: z.array(z.string().min(1)).optional(), limit: z.number().int().min(1).max(10_000).default(1000) })
  .passthrough();
const validateSchema = z
  .object({
    plan: planSchema,
    dataset: z
      .object({
        tables: z.array(
          z.object({
            name: z.string().min(1),
            columns: z.array(z.object({ name: z.string().min(1) }).passthrough()),
            rows: z.array(z.array(z.unknown())),
          }),
        ),
      })
      .passthrough(),
  })
  .passthrough();
const applySchema = z.object({ plan: planSchema }).passthrough();

export function planRoutes(registry: Registry, deps: Deps): Router {
  const router = Router();

  /** POST /extract/sample — amostra da origem no formato do /v1/anonymize do Data Layer. */
  router.post('/extract/sample', async (req, res) => {
    const input = parseBody(extractSchema, req.body);
    const schema = await deps.introspect(registry.source);
    res.json(await extractSample(registry.source, schema, input.tables, input.limit));
  });

  /** POST /validate/plan — fatos da origem + carga do dataset anonimizado no SANDBOX. */
  router.post('/validate/plan', async (req, res) => {
    const input = parseBody(validateSchema, req.body);
    const started = Date.now();
    const r = await validatePlan(registry, deps, input.plan.conflicts, input.dataset.tables);
    res.json({ valid: r.valid, checks: r.checks, issues: r.issues, sandbox: r.sandbox, durationMs: Date.now() - started });
  });

  /**
   * POST /plan/apply — gera o script de migracao do plano aprovado. NAO executa:
   * `applied: false`, `mode: "script"`. Escrever no destino e passo do DBA.
   */
  router.post('/plan/apply', async (req, res) => {
    const input = parseBody(applySchema, req.body);
    const started = Date.now();
    const [source, target] = await Promise.all([deps.introspect(registry.source), deps.introspect(registry.target)]);
    const tables = loadOrder(planTables(source, target, input.plan.conflicts));
    const invalid = new Map<string, number>();
    for (const t of tables) {
      for (const [col, f] of await sourceFacts(registry.source, t)) invalid.set(`${t.name}.${col}`, f.invalidDates);
    }
    const { script, statements } = migrationScript(target.schema, tables, invalid, { generatedAt: new Date().toISOString() });
    res.json({
      applied: false,
      mode: 'script',
      script,
      statements,
      tablesMigrated: tables.length,
      rowsMigrated: 0,
      durationMs: Date.now() - started,
    });
  });

  return router;
}
