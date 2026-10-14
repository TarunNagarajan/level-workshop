import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVisibilityManifest, stringLeaves } from './visibility-manifest.mjs';

test('initial API exposure fails a declared reveal even when the later click repeats it', () => {
  const manifest = compileVisibilityManifest({
    facts: [{ id: 'signature', variants: ['N. Vale'] }],
    frames: [
      { stage: 'closed', surfaces: { api: { documents: { card: { signature: 'N. Vale' } } }, observation: '' } },
      { stage: 'card', surfaces: { api: { documents: { card: { signature: 'N. Vale' } } }, observation: 'Signed N. Vale.' } },
    ],
    boundaries: { player: ['api', 'observation'] },
    rules: [{ factId: 'signature', boundary: 'player', earliestStage: 'card', mustReveal: true }],
  });
  assert.equal(manifest.status, 'violated');
  assert.equal(manifest.verdicts[0].firstExposure.stage, 'closed');
  assert.deepEqual(manifest.verdicts[0].firstExposure.exposures[0].paths, ['/documents/card/signature']);
});

test('derived comparison is exposed by its two ingredients before comparison text exists', () => {
  const mismatch = (_, leaves) => {
    const first = leaves.filter(leaf => leaf.text.includes('E. Vale'));
    const second = leaves.filter(leaf => leaf.text.includes('N. Vale'));
    return first.length && second.length ? [first[0].path, second[0].path] : [];
  };
  const manifest = compileVisibilityManifest({
    facts: [{ id: 'mismatch', derive: mismatch }],
    frames: [
      { stage: 'closed', surfaces: { api: { passport: { signature: 'E. Vale' }, card: { signature: 'N. Vale' } }, desk: '' } },
      { stage: 'compare', surfaces: { api: {}, desk: 'Passport: E. Vale. Card: N. Vale.' } },
    ],
    boundaries: { player: ['api'], modelDesk: ['desk'] },
    rules: [{ factId: 'mismatch', boundary: 'player', earliestStage: 'compare', mustReveal: true }],
  });
  assert.equal(manifest.firstByBoundary.mismatch.player.stage, 'closed');
  assert.equal(manifest.firstByBoundary.mismatch.modelDesk.stage, 'compare');
  assert.equal(manifest.verdicts[0].status, 'violated-early');
});

test('never-exposed protected truth and missing expected reveal are separate verdicts', () => {
  const manifest = compileVisibilityManifest({
    facts: [{ id: 'secret', variants: ['Noah Vale'] }, { id: 'uv', variants: ['thread is intact'] }],
    frames: [{ stage: 'closed', surfaces: { player: { text: 'Good evening.' }, model: 'Noah Vale' } }],
    boundaries: { player: ['player'], model: ['model'] },
    rules: [
      { factId: 'secret', boundary: 'player', never: true },
      { factId: 'uv', boundary: 'player', earliestStage: 'closed', mustReveal: true },
    ],
  });
  assert.equal(manifest.verdicts[0].status, 'satisfied');
  assert.equal(manifest.verdicts[1].status, 'missing-reveal');
  assert.equal(manifest.status, 'inconclusive');
  assert.equal(manifest.firstByBoundary.secret.model.stage, 'closed');
  assert.deepEqual(stringLeaves({ 'a/b': ['x'] }), [{ path: '/a~1b/0', text: 'x' }]);
});
