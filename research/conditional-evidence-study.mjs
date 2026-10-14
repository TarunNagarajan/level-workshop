import { writeFileSync } from 'node:fs';
import { auditConditionalEvidence, inspectEvidenceBelief } from './conditional-evidence-contract.mjs';

const worlds = [true, false].flatMap(seal => [true, false].map(match => ({
  id: `${seal ? 'intact' : 'broken'}-${match ? 'match' : 'mismatch'}`,
  seal, match, answer: seal && match ? 'clear' : 'hold',
})));
const actions = [
  { id: 'uv', observe: world => ({ thread: world.seal ? 'intact' : 'broken' }) },
  { id: 'compare', observe: world => ({ signatures: world.match ? 'match' : 'mismatch' }) },
  { id: 'move', observe: () => ({ moved: true }) },
];
const publicView = () => ({ scene: 'document desk', availableActions: actions.map(action => action.id) });
const intended = auditConditionalEvidence({ worlds, actions, publicView });
const leaked = auditConditionalEvidence({ worlds, actions, publicView: world => ({ ...publicView(), unopenedUvResult: world.seal }) });
const afterIntact = inspectEvidenceBelief({ worlds, actions, publicView, trueWorldId: 'intact-match', inspected: ['uv'] });
const afterBroken = inspectEvidenceBelief({ worlds, actions, publicView, trueWorldId: 'broken-match', inspected: ['uv'] });
const report = {
  scope: 'Finite, static, authored four-world scene; independent deterministic click outcomes. No browser or human playtest.',
  decisionRule: 'clear iff UV thread intact and signatures match; otherwise hold',
  intended, leakedInitialApi: leaked,
  conditionalObservation: { afterIntact, afterBroken },
};
writeFileSync('research/conditional-evidence-results.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ intended: intended.worlds.map(row => ({ worldId: row.worldId, minimal: row.minimalSufficientActionSets })), neverInMinimalSet: intended.neverInMinimalSet, leakedZeroClickWorlds: leaked.worlds.filter(row => row.initialSufficient).map(row => row.worldId) }, null, 2));
