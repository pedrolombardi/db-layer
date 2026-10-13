/**
 * npm run demo — o fluxo ponta a ponta, cross-platform (Node puro, sem bash/PowerShell):
 *   1. pede o diff ao DB Layer (dado real);
 *   2. manda cada conflito de JULGAMENTO para o /ai/analyze-conflict da AI Layer;
 *   3. imprime conflictId | regra | veredito | evidencia.
 *
 * A evidencia impressa e SEMPRE a do DB Layer (dado real). Se a AI Layer
 * responder `simulated: true`, o veredito sai marcado como simulado: numero
 * de mock nao aparece na tela como se fosse medicao.
 */

const DB = process.env.DB_LAYER_URL ?? 'http://localhost:3002';
const AI = process.env.AI_LAYER_URL ?? 'http://localhost:3001';

interface Conflict {
  conflictId: string;
  classification: string;
  rules: string[];
  reason: string;
}

async function post(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

async function main(): Promise<void> {
  const diff = (await post(`${DB}/schema/diff`)) as {
    summary: { columns: number; mecanico: number; julgamento: number };
    conflicts: Conflict[];
  };
  const { summary } = diff;
  console.log(
    `\n${summary.columns} colunas: o código resolve ${summary.mecanico} sozinho, ${summary.julgamento} precisam de julgamento\n`,
  );

  const rows: string[][] = [];
  for (const c of diff.conflicts.filter((x) => x.classification === 'julgamento')) {
    let verdict: string;
    try {
      const ai = (await post(`${AI}/ai/analyze-conflict`, c)) as { verdict: string; simulated?: boolean; proposal?: { targetType?: string } | null };
      verdict = ai.verdict + (ai.proposal?.targetType ? ` → ${ai.proposal.targetType}` : '') + (ai.simulated ? ' (AI simulada)' : '');
    } catch (err) {
      verdict = `ERRO: ${(err as Error).message}`;
    }
    rows.push([c.conflictId, c.rules.join(','), verdict, c.reason]);
  }

  const head = ['conflictId', 'regra', 'veredito', 'evidência (DB Layer, dado real)'];
  const w = [24, 26, 44, 64];
  console.log(head.map((h, i) => cut(h, w[i]!)).join(' | '));
  console.log(w.map((n) => '-'.repeat(n)).join('-|-'));
  for (const r of rows) console.log(r.map((v, i) => cut(v, w[i]!)).join(' | '));
  console.log('');
}

main().catch((err) => {
  console.error(`[demo] falhou: ${(err as Error).message}`);
  console.error(`[demo] o DB Layer está em ${DB} e a AI Layer em ${AI}? (DB_LAYER_URL / AI_LAYER_URL)`);
  process.exit(1);
});
