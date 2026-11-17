import { runAcpSeatTurn, type AcpSeatOptions, type AcpSeatDeps } from '../agents/acp-client.js';
import { resolveDevinModel, type DevinModelCatalog } from './models.js';

export function devinAcpSeatArgs(model: string): string[] {
  return ['acp', '--model', model];
}

export function devinQualifiedFreeModel(catalog: DevinModelCatalog, model: string): boolean {
  const resolved = resolveDevinModel(model, catalog);
  return catalog.source === 'cli' && resolved?.id === model && resolved.pricing.free === true && !model.endsWith('-lightning');
}

export function runDevinAcpSeat(
  opts: Omit<AcpSeatOptions, 'command' | 'args' | 'qualifyModel'> & { cliPath: string; catalog: DevinModelCatalog },
  deps: AcpSeatDeps = {},
) {
  return runAcpSeatTurn({ ...opts, command: opts.cliPath, args: devinAcpSeatArgs(opts.model),
    qualifyModel: (model) => devinQualifiedFreeModel(opts.catalog, model) }, deps);
}
