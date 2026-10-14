import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';

// Exact small-instance path cover for choosing browser replays from a finite reducer.
// This is a test-selection aid; the uncovered browser implementation may still leak.
const hash = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(readFileSync('research/equipment-first-use-study.json', 'utf8'));
const protocol = JSON.parse(readFileSync('research/equipment-first-use-protocol.json', 'utf8'));
assert.equal(report.status, 'passed');
const results = [];
for (const factor of protocol.factors) {
  const world = equipmentWorlds().find(item => item.id === factor.left);
  const paths = report.pathsByFactor[factor.name];
  const edgeSets = paths.map(path => {
    let state = world.initialState;
    const edges = [];
    for (const action of path) {
      assert.ok(world.enabled(state).includes(action));
      edges.push(JSON.stringify({ state, action }));
      state = world.step(state, action);
    }
    return edges;
  });
  const universe = new Set(edgeSets.flat());
  let chosen = null;
  for (let size = 1; size <= paths.length && !chosen; size++) {
    function choose(start, selected) {
      if (chosen) return;
      if (selected.length === size) {
        const covered = new Set(selected.flatMap(index => edgeSets[index]));
        if (covered.size === universe.size) chosen = selected;
        return;
      }
      for (let i = start; i <= paths.length - (size - selected.length); i++) choose(i + 1, [...selected, i]);
    }
    choose(0, []);
  }
  assert.ok(chosen);
  const selectedPaths = chosen.map(index => paths[index]);
  const selectedNames = new Set(selectedPaths.map(path => path.join(',')));
  const selectedVerdicts = report.verdicts.filter(row => row.factor === factor.name && selectedNames.has(row.path.join(',')));
  assert.equal(selectedVerdicts.length, selectedPaths.length * protocol.channels.length);
  assert.ok(selectedVerdicts.every(row => row.status === (row.channel === 'downloadedBytes' ? 'unrevealed' : 'revealed-at-event')));
  results.push({ factor: factor.name, candidatePaths: paths.length, distinctStateActionEdges: universe.size,
    minimumCoverSize: chosen.length, selectedPaths, selectedVerdicts: selectedVerdicts.length,
    proof: `All smaller subsets, sizes 1 through ${chosen.length - 1}, were enumerated without complete edge coverage.` });
}
const sourceFiles = ['research/equipment-transition-cover.mjs', 'research/equipment-first-use-study.json',
  'research/equipment-first-use-protocol.json', 'research/dynamic-evidence-fixture.mjs'];
const output = { status: 'analyzed', scope: 'Exact set cover of authored reducer state-action edges over saved legal full orders. This selects browser tests; it does not certify untested browser paths or model behavior.',
  sourceHashes: Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(path))])), results };
writeFileSync('research/equipment-transition-cover.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ status: output.status, factors: results.map(row => ({ factor: row.factor,
  candidates: row.candidatePaths, edges: row.distinctStateActionEdges, minimumCover: row.minimumCoverSize })) }));
