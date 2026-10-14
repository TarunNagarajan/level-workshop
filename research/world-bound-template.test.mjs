import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditWorldTemplate, bindWorldLevel } from '../server/world-bound-template.mjs';
import { emptyLevel, compilePrompt } from '../server/levels.mjs';
import { passportLevel, passportStudyFactDefinitions, passportStudyLevelTemplate, passportStudyWorld } from '../server/passport-reference.mjs';
import { equipmentWorlds } from './dynamic-evidence-fixture.mjs';

const passportWorlds = ['match-intact', 'match-broken', 'mismatch-intact', 'mismatch-broken']
  .map(id => ({ id, facts: passportStudyWorld(id).facts }));

test('one passport template compiles four distinct world-faithful target requests', () => {
  const report = auditWorldTemplate({ template: passportStudyLevelTemplate, definitions: passportStudyFactDefinitions, worlds: passportWorlds });
  assert.equal(report.status, 'passed');
  assert.equal(report.worlds.length, 4);
  assert.equal(new Set(report.worlds.map(row => row.promptHash)).size, 4);
  assert.equal(new Set(report.worlds.map(row => row.normalizedHash)).size, 1);
  for (const row of report.worlds) {
    const world = passportStudyWorld(row.id);
    assert.equal(row.bindings.cardRelation.value, world.signatureFact);
    assert.equal(row.bindings.uvAssessment.value, world.uvFact);
  }
});

test('a hardcoded default, omitted fact, and hidden compiler branch fail before a model call', () => {
  assert.throws(() => bindWorldLevel({ ...passportStudyLevelTemplate, systemPrompt: passportLevel.systemPrompt }, passportStudyFactDefinitions, passportWorlds[0].facts), /Unbound world fact cardRelation in systemPrompt/);
  assert.throws(() => bindWorldLevel({ ...passportStudyLevelTemplate, clues: 'Only {{world.cardRelation}}.' }, passportStudyFactDefinitions, passportWorlds[0].facts), /uvAssessment is never bound/);
  assert.throws(() => bindWorldLevel({ ...passportStudyLevelTemplate, clues: '{{world.unknown}}' }, passportStudyFactDefinitions, passportWorlds[0].facts), /Unknown world placeholder unknown/);
  assert.throws(() => auditWorldTemplate({ template: passportStudyLevelTemplate, definitions: passportStudyFactDefinitions, worlds: passportWorlds, compile: () => 'A constant request.' }), /Compiled target omitted/);
  assert.throws(() => auditWorldTemplate({ template: passportStudyLevelTemplate, definitions: passportStudyFactDefinitions, worlds: passportWorlds, compile: level => {
    const prompt = compilePrompt(level);
    return prompt + (level.clues.includes('N. Vale') ? '\nUnbound condition: check the baggage.' : '');
  } }), /Unbound target difference/);
  assert.throws(() => auditWorldTemplate({ template: passportStudyLevelTemplate, definitions: passportStudyFactDefinitions, worlds: passportWorlds, compile: level =>
    compilePrompt(level) + (level.clues.includes('N. Vale') ? '\nN. Vale' : '') }), /Unbound target difference/);
});

test('the same compiler audits a separate equipment-inspection family', () => {
  const template = {
    ...emptyLevel,
    character: 'The technician',
    secret: 'The unit has {{world.voltage}} and {{world.fuse}}.',
    criteria: 'Release only when both checks pass.',
    systemPrompt: 'You are the inspection technician. Record {{world.voltage}} and {{world.fuse}}. Wait for actual inspection events before approving release.',
  };
  const definitions = {
    voltage: { variants: { stable: 'Voltage status PASS', unstable: 'Voltage status FAIL' } },
    fuse: { variants: { intact: 'Fuse status PASS', blown: 'Fuse status FAIL' } },
  };
  const worlds = equipmentWorlds().map(world => ({ id: world.id, facts: { voltage: world.voltage, fuse: world.fuse } }));
  const report = auditWorldTemplate({ template, definitions, worlds });
  assert.equal(report.status, 'passed');
  assert.equal(new Set(report.worlds.map(row => row.promptHash)).size, 4);
  assert.equal(new Set(report.worlds.map(row => row.normalizedHash)).size, 1);
  assert.throws(() => auditWorldTemplate({ template: { ...template, clues: 'Voltage status PASS.' }, definitions, worlds }), /Unbound world fact voltage in clues/);
});

test('provenance markers distinguish values even when one contains another', () => {
  const template = { ...emptyLevel, secret: 'The reading is {{world.voltage}}.' };
  const report = auditWorldTemplate({ template, definitions: { voltage: { variants: { stable: 'stable', unstable: 'unstable' } } },
    worlds: [{ id: 'a', facts: { voltage: 'stable' } }, { id: 'b', facts: { voltage: 'unstable' } }] });
  assert.equal(report.status, 'passed');
  assert.notEqual(report.worlds[0].promptHash, report.worlds[1].promptHash);
  assert.throws(() => auditWorldTemplate({ template, definitions: {}, worlds: [{ id: 'a', facts: {} }, { id: 'b', facts: {} }] }), /at least one variable world fact/);
});
