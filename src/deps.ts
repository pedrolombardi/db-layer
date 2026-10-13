import { DbAdapter } from './db/types';
import { introspect } from './schema/introspect';
import { ProbeRunner } from './schema/diff';
import { sqlProbeRunner } from './schema/probes';
import { NormSchema } from './schema/types';

/** Pontos de I/O injetaveis: os testes de rota trocam por fakes. */
export interface Deps {
  introspect(adapter: DbAdapter): Promise<NormSchema>;
  probeRunner(adapter: DbAdapter): ProbeRunner;
}

export const defaultDeps: Deps = { introspect, probeRunner: sqlProbeRunner };
