import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { synthesizeRevealRepair } from './reveal-repair.mjs';

const manifest = JSON.parse(readFileSync('research/reference-visibility-manifest.json', 'utf8'));
const browser = JSON.parse(readFileSync('research/reference-dom-visibility.json', 'utf8'));
const actions = [
  { id: 'open' }, { id: 'card' },
  { id: 'turn', requiresAll: ['open'] },
  { id: 'uv' },
  { id: 'compare', requiresAll: ['open', 'card'] },
];
const derived = [{ fact: 'signatureMismatch', from: ['passportSignature', 'cardSignature'] }];
const targets = [
  { action: 'open', fact: 'passportSignature' }, { action: 'card', fact: 'cardSignature' },
  { action: 'turn', fact: 'stampDate' }, { action: 'uv', fact: 'uvIntact' },
  { action: 'compare', fact: 'signatureMismatch' },
];
const actionSources = [
  { id: 'open-signature', fact: 'passportSignature', at: 'open', editable: false },
  { id: 'card-signature', fact: 'cardSignature', at: 'card', editable: false },
  { id: 'turn-stamp', fact: 'stampDate', at: 'turn', editable: false },
  { id: 'uv-result', fact: 'uvIntact', at: 'uv', editable: false },
  { id: 'compare-sentence', fact: 'signatureMismatch', at: 'compare', editable: false },
];
const locate = (fact, surface) => manifest.firstBySurface[fact][surface]?.paths ?? [];
const initialSources = {
  playerAccessible: [],
  visibleHistory: [],
  modelVerifiedDesk: [],
  modelFullRequest: [
    { id: 'static-card-signature', fact: 'cardSignature', at: 'initial', editable: true, surface: 'modelStaticSystem', paths: locate('cardSignature', 'modelStaticSystem') },
    { id: 'static-stamp-date', fact: 'stampDate', at: 'initial', editable: true, surface: 'modelStaticSystem', paths: locate('stampDate', 'modelStaticSystem') },
    { id: 'static-uv-result', fact: 'uvIntact', at: 'initial', editable: true, surface: 'modelStaticSystem', paths: locate('uvIntact', 'modelStaticSystem') },
  ],
};
for (const source of Object.values(initialSources).flat()) assert.ok(source.paths.length, `Initial source missing from actual visibility manifest: ${source.id}`);
for (const fact of ['passportSignature', 'cardSignature', 'stampDate', 'uvIntact']) assert.notEqual(browser.firstByBoundary[fact].visibleHistory?.stage, 'closed');
const boundaries = Object.fromEntries(Object.entries(initialSources).map(([boundary, initial]) => [boundary, {
  sources: [...initial, ...actionSources],
  repairs: Object.fromEntries(targets.map(target => [target.action, synthesizeRevealRepair({
    actions, derived, sources: [...initial, ...actionSources], targetAction: target.action, targetFact: target.fact,
  })])),
}]));
assert.equal(boundaries.playerAccessible.repairs.turn.status, 'no-edit-needed-by-preflight');
assert.equal(boundaries.playerAccessible.repairs.compare.status, 'infeasible-under-pins');
assert.equal(boundaries.visibleHistory.repairs.compare.status, 'infeasible-under-pins');
assert.equal(boundaries.modelVerifiedDesk.repairs.compare.status, 'infeasible-under-pins');
assert.equal(boundaries.modelFullRequest.repairs.compare.status, 'infeasible-under-pins');
const sourceFiles = ['server/passport-reference.mjs', 'src/PassportReference.tsx', 'research/prerequisite-closure.mjs', 'research/reveal-repair.mjs', 'research/reference-reveal-repairs.mjs', 'research/reference-visibility-manifest.json', 'research/reference-dom-visibility.json'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const report = {
  scope: 'Cardinality-minimal logical source-delay suggestions under a manually declared action/fact contract and pinned earlier action reveals. Initial sources are grounded in local visibility manifests. A source may contain several literal occurrences, so plan size is not the number of code edits. Suggestions do not rewrite or certify the app.',
  sourceHashes, actions, derived, targets, boundaries,
};
writeFileSync('research/reference-reveal-repairs.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(boundaries).map(([boundary, data]) => [boundary,
  Object.fromEntries(Object.entries(data.repairs).map(([action, repair]) => [action, { status: repair.status, minimalEditCount: repair.minimalEditCount, plans: repair.plans.map(plan => plan.remove) }]))
]))));
