/**
 * npm run evidencias — gera a evidencia da prova de conceito contra os bancos
 * REAIS (MySQL 8 + Oracle 23ai Free do docker compose): chama cada endpoint e
 * salva a resposta crua em docs/evidencias/, mais um RESUMO.md legivel.
 * Reprodutivel: qualquer pessoa do grupo roda e obtem os mesmos numeros.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DB = process.env.DB_LAYER_URL ?? 'http://localhost:3002';
const OUT = join(__dirname, '..', 'docs', 'evidencias');

interface Call {
  file: string;
  title: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

const CALLS: Call[] = [
  { file: '01-health-db.json', title: 'Conexao real com origem (MySQL, somente leitura) e destino (Oracle)', method: 'GET', path: '/health/db' },
  { file: '02-introspect.json', title: 'Introspeccao normalizada dos dois catalogos', method: 'GET', path: '/schema/introspect' },
  { file: '03-diff.json', title: 'Diff classificado: mecanico x julgamento', method: 'POST', path: '/schema/diff' },
  { file: '04-profile-email.json', title: 'Evidencia: e-mails que nao cabem no destino', method: 'POST', path: '/tools/profile-column', body: { database: 'mysql', table: 'clientes', column: 'email' } },
  { file: '05-sample-ativo.json', title: 'Evidencia: valores distintos de clientes.ativo', method: 'POST', path: '/tools/sample-values', body: { database: 'mysql', table: 'clientes', column: 'ativo' } },
  { file: '06-check-charset.json', title: 'Evidencia: charset da coluna de origem', method: 'POST', path: '/tools/check-charset', body: { database: 'mysql', table: 'clientes', column: 'email' } },
  { file: '07-injecao-recusada.json', title: 'Seguranca: tentativa de injecao recusada sem executar consulta', method: 'POST', path: '/tools/profile-column', body: { database: 'mysql', table: 'clientes; DROP TABLE clientes', column: 'email' } },
  { file: '08-lgpd-cpf-mascarado.json', title: 'LGPD: coluna de alta cardinalidade (CPF) nao expoe valores', method: 'POST', path: '/tools/sample-values', body: { database: 'mysql', table: 'clientes', column: 'cpf' } },
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const lines = [
    '# Evidências da PoC — DB Layer',
    '',
    `Gerado por \`npm run evidencias\` em ${new Date().toISOString()} contra ${DB}`,
    '(bancos reais do `docker compose`: MySQL 8.0 e Oracle Database 23ai Free).',
    '',
    '| # | Evidência | Requisição | HTTP | Destaque |',
    '|---|---|---|---|---|',
  ];

  for (const [i, c] of CALLS.entries()) {
    const res = await fetch(DB + c.path, {
      method: c.method,
      headers: { 'content-type': 'application/json' },
      body: c.body === undefined ? undefined : JSON.stringify(c.body),
    });
    const body = (await res.json()) as Record<string, unknown>;
    writeFileSync(join(OUT, c.file), JSON.stringify({ request: { method: c.method, path: c.path, body: c.body }, status: res.status, response: body }, null, 2) + '\n');
    lines.push(`| ${i + 1} | ${c.title} | \`${c.method} ${c.path}\` | ${res.status} | ${highlight(c.file, body)} |`);
  }

  writeFileSync(join(OUT, 'RESUMO.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  console.log(`\nArquivos em ${OUT}`);
}

function highlight(file: string, b: Record<string, unknown>): string {
  const get = (k: string) => JSON.stringify(b[k]);
  if (file.startsWith('01')) return `status ${get('status')}; origem readOnly=${JSON.stringify((b.source as Record<string, unknown>)?.readOnly)}`;
  if (file.startsWith('02')) return Object.entries(b).map(([side, s]) => `${side}: ${(s as { tables: unknown[] }).tables.length} tabelas`).join('; ');
  if (file.startsWith('03')) {
    const conflicts = (b.conflicts as { classification: string; conflictId: string }[]).filter((c) => c.classification === 'julgamento');
    return `${get('summary')} — julgamento: ${conflicts.map((c) => c.conflictId).join(', ')}`;
  }
  if (file.startsWith('04')) return `${get('valuesAboveThreshold')} de ${get('totalRows')} acima de ${get('lengthThreshold')} ${b.thresholdUnit}; máx. ${get('maxObservedLength')}`;
  if (file.startsWith('05')) return `values ${get('values')}`;
  if (file.startsWith('06')) return `${get('charset')} / ${get('collation')} / ${get('maxBytesPerCharacter')} bytes por caractere`;
  if (file.startsWith('07')) return `${get('code')}`;
  if (file.startsWith('08')) return `masked=${get('masked')}, values ${get('values')}`;
  return '';
}

main().catch((err) => {
  console.error(`[evidencias] falhou: ${(err as Error).message} — o DB Layer está de pé em ${DB}?`);
  process.exit(1);
});
