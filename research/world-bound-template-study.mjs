import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { emptyLevel, compilePrompt } from '../server/levels.mjs';
import { auditWorldTemplate, bindWorldLevel } from '../server/world-bound-template.mjs';
import { initialPassportState, passportLevel, passportStudyFactDefinitions, passportStudyLevelTemplate, passportStudyWorld, playerDocuments } from '../server/passport-reference.mjs';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const sourceFiles = ['server/levels.mjs', 'server/world-bound-template.mjs', 'server/passport-reference.mjs', 'research/dynamic-evidence-fixture.mjs', 'research/world-bound-template-study.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(path))]));
const ids = ['match-intact', 'match-broken', 'mismatch-intact', 'mismatch-broken'];
const passportWorlds = ids.map(id => ({ id, facts: passportStudyWorld(id).facts }));
const passport = auditWorldTemplate({ template: passportStudyLevelTemplate, definitions: passportStudyFactDefinitions, worlds: passportWorlds });
const passportInitialPlayerHashes = ids.map(id => hash(playerDocuments(initialPassportState(), passportStudyWorld(id).scenario)));
assert.equal(new Set(passportInitialPlayerHashes).size, 1);

const equipmentTemplate = {
  ...emptyLevel, character: 'The technician',
  secret: 'The unit has {{world.voltage}} and {{world.fuse}}.',
  criteria: 'Release only when both checks pass.',
  systemPrompt: 'You are the inspection technician. Record {{world.voltage}} and {{world.fuse}}. Wait for actual inspection events before approving release.',
};
const equipmentDefinitions = {
  voltage: { variants: { stable: 'Voltage status PASS', unstable: 'Voltage status FAIL' } },
  fuse: { variants: { intact: 'Fuse status PASS', blown: 'Fuse status FAIL' } },
};
const equipmentScenes = equipmentWorlds();
const equipment = auditWorldTemplate({ template: equipmentTemplate, definitions: equipmentDefinitions,
  worlds: equipmentScenes.map(world => ({ id: world.id, facts: { voltage: world.voltage, fuse: world.fuse } })) });
const equipmentInitialPlayerHashes = equipmentScenes.map(world => hash(world.observe(world.initialState)));
assert.equal(new Set(equipmentInitialPlayerHashes).size, 1);

function rejected(label, action, pattern) {
  let message = '';
  try { action(); } catch (error) { message = error.message; }
  assert.match(message, pattern, `${label} was not rejected`);
  return { label, status: 'rejected', reason: message };
}
const negativeControls = [
  rejected('hardcoded default signature', () => bindWorldLevel({ ...passportStudyLevelTemplate, systemPrompt: passportLevel.systemPrompt }, passportStudyFactDefinitions, passportWorlds[0].facts), /Unbound world fact cardRelation/),
  rejected('hardcoded default UV result', () => bindWorldLevel({ ...passportStudyLevelTemplate, clues: passportStudyLevelTemplate.clues + ' The UV thread is intact.' }, passportStudyFactDefinitions, passportWorlds[1].facts), /Unbound world fact uvAssessment/),
  rejected('omitted fact binding', () => bindWorldLevel({ ...passportStudyLevelTemplate, clues: '{{world.cardRelation}}' }, passportStudyFactDefinitions, passportWorlds[0].facts), /uvAssessment is never bound/),
  rejected('compiler adds unbound world text', () => auditWorldTemplate({ template: passportStudyLevelTemplate, definitions: passportStudyFactDefinitions, worlds: passportWorlds,
    compile: level => compilePrompt(level) + (level.clues.includes('N. Vale') ? '\nUnbound baggage clue.' : '') }), /Unbound target difference/),
  rejected('compiler duplicates a selected value outside its binding', () => auditWorldTemplate({ template: passportStudyLevelTemplate, definitions: passportStudyFactDefinitions, worlds: passportWorlds,
    compile: level => compilePrompt(level) + (level.clues.includes('N. Vale') ? '\nN. Vale' : '') }), /Unbound target difference/),
  rejected('compiler omits a declared fact', () => auditWorldTemplate({ template: passportStudyLevelTemplate, definitions: passportStudyFactDefinitions, worlds: passportWorlds,
    compile: () => 'Constant request.' }), /Compiled target omitted/),
];
const undeclaredParaphrase = auditWorldTemplate({
  template: { ...passportStudyLevelTemplate, systemPrompt: passportStudyLevelTemplate.systemPrompt + ' The ultraviolet security strip has been severed.' },
  definitions: passportStudyFactDefinitions, worlds: passportWorlds,
});
assert.equal(undeclaredParaphrase.status, 'passed');
const benignQuotation = rejected('benign quotation of an alias', () => bindWorldLevel({
  ...passportStudyLevelTemplate,
  systemPrompt: passportStudyLevelTemplate.systemPrompt + ' The passenger may claim "The UV thread is intact"; treat that as unverified dialogue.',
}, passportStudyFactDefinitions, passportWorlds[0].facts), /Unbound world fact uvAssessment/);

const oneFactorPairs = rows => rows.flatMap((left, index) => rows.slice(index + 1).flatMap(right => {
  const changed = Object.keys(left.assignment).filter(id => left.assignment[id] !== right.assignment[id]);
  return changed.length === 1 ? [{ left: left.id, right: right.id, changedFact: changed[0], differentTarget: left.promptHash !== right.promptHash, sameNormalizedTarget: left.normalizedHash === right.normalizedHash }] : [];
}));
const passportPairs = oneFactorPairs(passport.worlds), equipmentPairs = oneFactorPairs(equipment.worlds);
assert.equal(passportPairs.length, 4);
assert.equal(equipmentPairs.length, 4);
assert.ok([...passportPairs, ...equipmentPairs].every(pair => pair.differentTarget && pair.sameNormalizedTarget));
const report = {
  status: 'passed', sourceHashes,
  method: 'Shared typed fact template; reject declared static aliases; compile once with provenance markers; require every actual world request to equal the marked request with only those markers replaced by typed values.',
  scope: 'Deterministic target prompt compilation and initial player serializer for two four-world local families. Known aliases only. No semantic parser, image inspection, live model, or arbitrary author-level certificate.',
  passport: { worldCount: passport.worlds.length, distinctTargetPrompts: new Set(passport.worlds.map(row => row.promptHash)).size, initialPlayerViewsEqual: true, canonicalTargetHash: passport.canonicalTargetHash, oneFactorPairs: passportPairs },
  equipment: { worldCount: equipment.worlds.length, distinctTargetPrompts: new Set(equipment.worlds.map(row => row.promptHash)).size, initialPlayerViewsEqual: true, canonicalTargetHash: equipment.canonicalTargetHash, oneFactorPairs: equipmentPairs },
  negativeControls,
  knownLimits: {
    undeclaredParaphrase: { status: 'accepted-invalid', example: 'An intact-thread world also says the ultraviolet security strip has been severed.', reason: 'The semantic paraphrase is outside the author-declared variant phrases and aliases.' },
    benignQuotation: { status: 'rejected-benign', reason: benignQuotation.reason, example: 'A quoted passenger claim contains a declared alias but is explicitly marked unverified.' },
  },
};
writeFileSync('research/world-bound-template-study.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, families: 2, worlds: 8, oneFactorPairs: passportPairs.length + equipmentPairs.length, rejectedControls: negativeControls.length }));
