import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  ['free-form user handoff', 'research/route-pilot.json'],
  ['free-form system handoff', 'research/route-system-pilot.json'],
  ['typed system state', 'research/route-state-pilot.json'],
];
const summary = files.map(([label, path]) => {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const vehicle = row => data.worlds.find(world => world.id === row.world)?.vehicle;
  const before = data.observations.filter(row => row.phase === 'before handoff');
  const afterB = data.observations.filter(row => row.role === 'B' && row.phase === 'after route handoff');
  const afterC = data.observations.filter(row => row.role === 'C' && row.phase === 'after plan handoff');
  return {
    label, path, probes: data.observations.length, providerErrorsAcrossAttempts: data.providerErrors.length,
    noResponse: data.observations.filter(row => row.response === null).length,
    protocolErrors: data.protocolErrors,
    fullCaseBEarlyVehicle: before.filter(row => row.visibility === 'full-case' && row.role === 'B' && row.response?.toLowerCase().includes(vehicle(row))).length,
    gatedPreExactWaits: before.filter(row => row.visibility === 'gated' && row.response === (row.role === 'B' ? 'Awaiting route.' : 'Awaiting plan.')).length,
    gatedPreProbes: before.filter(row => row.visibility === 'gated').length,
    afterBExactVehicle: afterB.filter(row => row.response === vehicle(row)).length,
    afterBProbes: afterB.length,
    afterCCorrectPlan: afterC.filter(row => row.response?.includes(vehicle(row)) && row.response?.includes(data.worlds.find(world => world.id === row.world).openRoute)).length,
    afterCProbes: afterC.length,
  };
});
writeFileSync('research/route-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
