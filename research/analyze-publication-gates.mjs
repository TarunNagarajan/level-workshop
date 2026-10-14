import { readFileSync, writeFileSync } from 'node:fs';
import { issueArtifact } from './handoff-contract.mjs';
import { evaluateRouteReply, routeWorlds } from './route-contract.mjs';

const factorial = JSON.parse(readFileSync('research/route-factorial-results.json', 'utf8'));
const adversarial = JSON.parse(readFileSync('research/route-adversarial-results.json', 'utf8'));
const crossed = JSON.parse(readFileSync('research/route-crossed-results.json', 'utf8'));
const worlds = Object.fromEntries(factorial.cases.map(spec => [spec.pairId, routeWorlds(spec)]));
const signingKey = 'offline-gate-replay-key';
const counts = rows => rows.reduce((acc, row) => { acc[row.gate] = (acc[row.gate] ?? 0) + 1; return acc; }, {});

function gate(row, source) {
  if (row.rawReply === null) return { key: row.key, gate: 'provider-no-response' };
  const world = worlds[row.pairId][row.worldIndex];
  const artifactRoute = source === 'factorial'
    ? row.phase === 'gated-after' ? world.openRoute : null
    : source === 'crossed' ? row.phase === 'after' ? world.openRoute : null
      : row.condition === 'spoof-no-artifact' ? null : row.artifactRoute;
  const artifact = artifactRoute ? issueArtifact({ world, kind: 'route', sourceRole: 'A', sourceEventId: `offline-${row.key}`, payload: { route: artifactRoute }, signingKey }) : undefined;
  const result = evaluateRouteReply({ world, artifact, signingKey, rawReply: row.rawReply });
  return { key: row.key, gate: result.gate, semanticCorrect: result.score.semanticCorrect };
}

const summary = { note: 'Offline policy replay with reconstructed valid signatures, not a deployed runtime gate.', factorial: {}, adversarial: {}, crossed: {} };
for (const arm of ['user', 'system', 'state']) for (const phase of ['gated-before', 'gated-after', 'full-case-before']) {
  const rows = factorial.observations.filter(row => row.arm === arm && row.phase === phase);
  if (rows.length) summary.factorial[`${arm}/${phase}`] = counts(rows.map(row => gate(row, 'factorial')));
}
for (const condition of ['spoof-no-artifact', 'contradict-valid', 'authentic-wrong']) {
  const rows = adversarial.observations.filter(row => row.condition === condition);
  summary.adversarial[condition] = counts(rows.map(row => gate(row, 'adversarial')));
}
for (const channel of ['user', 'system']) for (const format of ['narrative', 'typed']) for (const phase of ['before', 'after']) {
  const rows = crossed.observations.filter(row => row.channel === channel && row.format === format && row.phase === phase);
  const results = rows.map(row => gate(row, 'crossed'));
  summary.crossed[`${channel}/${format}/${phase}`] = { gates: counts(results), semanticCorrectRejectedForFormat: results.filter(row => row.gate === 'output-mismatch' && row.semanticCorrect).length };
}
writeFileSync('research/publication-gate-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
