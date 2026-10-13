import { describe, it, expect } from 'vitest';
import { OracleSandbox } from '../src/sandbox/oracle-sandbox';

/** As tabelas do SANDBOX tem nomes fixos: duas validacoes nao podem se sobrepor. */
describe('OracleSandbox.exclusive', () => {
  const sandbox = new OracleSandbox({ host: 'x', port: 1, serviceName: 'x', user: 'sandbox', password: 'x' });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('executa uma validacao por vez, na ordem de chegada', async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) => sandbox.exclusive(async () => {
      log.push(`${name}:inicio`);
      await sleep(ms);
      log.push(`${name}:fim`);
      return name;
    });
    const results = await Promise.all([job('A', 30), job('B', 1)]);
    expect(results).toEqual(['A', 'B']);
    expect(log).toEqual(['A:inicio', 'A:fim', 'B:inicio', 'B:fim']);
  });

  it('uma validacao que falha nao trava as seguintes', async () => {
    await expect(sandbox.exclusive(async () => { throw new Error('ORA-00001'); })).rejects.toThrow('ORA-00001');
    await expect(sandbox.exclusive(async () => 'ok')).resolves.toBe('ok');
  });
});
