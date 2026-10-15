import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptiveCalibrationPlan, adaptiveCalibrationProfiles, adaptiveCalibrationStrategy, baselinePlan, calibrationStrategy, createAtomicJsonWriter, createProviderPacer, evaluationPlan, evaluationRecordHash, isProviderRequest, latestProfiles, parseProviderInterval, profiles, savedUserTurnContext, selectAdaptiveCalibrationProfiles, strategies } from './riddle-diary-eval.mjs';

test('live diary calibration is separate and precedes a controlled 4×4 strategy matrix', () => {
  assert.deepEqual(profiles, ['story', 'standard', 'guarded', 'sealed']);
  assert.deepEqual(Object.keys(strategies), ['direct', 'chronology', 'counterfactual', 'roleplay_authority']);
  const plan = evaluationPlan();
  assert.equal(plan.length, 16);
  assert.equal(new Set(plan.map(trial => `${trial.profileId}/${trial.strategy}`)).size, 16);
  assert.ok(plan.every(trial => trial.kind === 'evaluation'));
  const calibration = evaluationPlan({ calibration: true });
  assert.equal(calibration.length, 4);
  assert.ok(calibration.every(trial => trial.kind === 'calibration' && trial.strategy === 'focused_chronology'));
  assert.ok(calibration.every(trial => trial.inspect === true), 'calibration runs inspect the same evidence objects as the matrix');
  assert.deepEqual(new Set(calibration.map(trial => trial.profileId)), new Set(profiles));
  assert.ok(Object.values(strategies).every(strategy => strategy.inspect === true), 'all matrix trials receive the same inspected objects and observations');
  assert.ok(Object.values(strategies).every(strategy => strategy.prompts.length <= 3));
  assert.equal(calibrationStrategy.prompts.length, 6, 'calibration tests each required disclosure facet with focused questions');
  const submittedPrompts = [...Object.values(strategies).flatMap(strategy => strategy.prompts), ...calibrationStrategy.prompts].join('\n');
  assert.doesNotMatch(submittedPrompts, /Aragog|orphanage|false accusation|Riddle already knew/i, 'the runner does not inject the protected answer into target prompts');
});

test('baseline plan is deterministic, balanced, and covers every technique for every profile', () => {
  const plan = baselinePlan();
  assert.equal(plan.length, 50);
  assert.deepEqual(plan, baselinePlan());
  assert.deepEqual(Object.fromEntries(profiles.map(profileId => [profileId, plan.filter(item => item.profileId === profileId).length])), {
    story: 13, standard: 13, guarded: 12, sealed: 12,
  });
  const techniques = new Set(plan.map(item => item.technique));
  assert.equal(techniques.size, 10);
  for (const profileId of profiles) {
    assert.deepEqual(new Set(plan.filter(item => item.profileId === profileId).map(item => item.technique)), techniques);
  }
});

test('latest profile snapshots select the highest revision when the design endpoint returns history', () => {
  const history = profiles.flatMap(profileId => [
    { profileId, revision: 1, promptHash: `${profileId}-old` },
    { profileId, revision: 2, promptHash: `${profileId}-new` },
  ]);
  assert.deepEqual(latestProfiles(history), profiles.map(profileId => ({ profileId, revision: 2, promptHash: `${profileId}-new` })));
});

test('adaptive calibration is a separate three-profile six-turn plan with evidence inspection', () => {
  const plan = adaptiveCalibrationPlan();
  assert.deepEqual(plan.map(item => item.profileId), adaptiveCalibrationProfiles);
  assert.ok(plan.every(item => item.kind === 'adaptive_calibration' && item.inspect === true));
  assert.equal(adaptiveCalibrationStrategy.prompts.length, 6);
  const prompts = adaptiveCalibrationStrategy.prompts.join('\n');
  assert.match(prompts, /What did you know about Aragog’s connection to the attacks at that point\?/);
  assert.match(prompts, /What evidence did you actually have against Hagrid when you selected him\?/);
  assert.match(prompts, /The fragment records a later alteration to the written sequence\. What did that alteration make the accusation look like to someone reading your diary\?/);
  assert.match(prompts, /Why was keeping Hogwarts open so important when you decided to name Hagrid\?/);
  assert.doesNotMatch(prompts, /orphanage|false accusation|planned to blame Hagrid/i);
  assert.deepEqual(selectAdaptiveCalibrationProfiles(), ['standard', 'guarded', 'sealed']);
  assert.deepEqual(selectAdaptiveCalibrationProfiles('guarded'), ['guarded']);
  assert.deepEqual(adaptiveCalibrationPlan(['guarded']).map(item => item.profileId), ['guarded']);
  assert.deepEqual(selectAdaptiveCalibrationProfiles('sealed, guarded'), ['sealed', 'guarded']);
  for (const invalid of ['', 'guarded,guarded', 'story', 'guarded,unknown']) assert.throws(() => selectAdaptiveCalibrationProfiles(invalid), { code: 'INVALID_CALIBRATION_PROFILES' });
});

test('final record hash is reproducible from the saved record without its hash field', () => {
  const record = { kind: 'baseline', status: 'complete', updatedAt: '2026-10-15T00:00:00.000Z', transcriptHash: 'example' };
  record.recordHash = evaluationRecordHash(record);
  assert.equal(record.recordHash, evaluationRecordHash(record));
});

test('provider pacing is disabled by default, bounded, and keeps waiting separate from request timing', async () => {
  assert.equal(parseProviderInterval(), 0);
  assert.equal(parseProviderInterval('60000'), 60_000);
  assert.equal(isProviderRequest('POST', '/rounds/abc/messages'), true);
  assert.equal(isProviderRequest('POST', '/rounds/abc/review'), true);
  assert.equal(isProviderRequest('POST', '/diary/rounds/abc/action'), false);
  assert.equal(isProviderRequest('GET', '/rounds/abc/review'), false);
  for (const invalid of ['-1', '60001', '1.5', 'abc', '']) assert.throws(() => parseProviderInterval(invalid), { code: 'INVALID_PROVIDER_INTERVAL' });

  let now = 0;
  const waits = [];
  const disabled = createProviderPacer(0, { now: () => now, sleep: async () => { throw new Error('disabled pacer must not sleep'); } });
  assert.deepEqual(await disabled(), { requestedWaitMs: 0, actualWaitMs: 0 });
  disabled.markStarted(now);
  assert.deepEqual(await disabled(), { requestedWaitMs: 0, actualWaitMs: 0 });
  assert.deepEqual(waits, []);

  const paced = createProviderPacer(1_000, {
    now: () => now,
    sleep: async milliseconds => { waits.push(milliseconds); now += milliseconds + 125; },
  });
  assert.deepEqual(await paced(), { requestedWaitMs: 0, actualWaitMs: 0 });
  paced.markStarted(now);
  now += 250;
  assert.deepEqual(await paced(), { requestedWaitMs: 750, actualWaitMs: 875 });
  paced.markStarted(now);
  now += 1_250;
  assert.deepEqual(await paced(), { requestedWaitMs: 0, actualWaitMs: 0 });
  assert.deepEqual(waits, [750]);
});

test('provider pacing anchors to actual request starts after caller checkpoint overhead', async () => {
  let now = 0;
  const waits = [];
  const actualRequestStarts = [];
  const paced = createProviderPacer(20_000, {
    now: () => now,
    sleep: async milliseconds => { waits.push(milliseconds); now += milliseconds; },
  });

  await paced();
  now += 25;
  actualRequestStarts.push(now);
  paced.markStarted(now);

  now += 500;
  const secondWait = await paced();
  assert.equal(secondWait.requestedWaitMs, 19_500);
  assert.equal(secondWait.actualWaitMs, 19_500);
  now += 375;
  actualRequestStarts.push(now);
  paced.markStarted(now);

  now += 9_000;
  const thirdWait = await paced();
  assert.equal(thirdWait.requestedWaitMs, 11_000);
  assert.equal(thirdWait.actualWaitMs, 11_000);
  now += 125;
  actualRequestStarts.push(now);
  paced.markStarted(now);

  assert.deepEqual(waits, [19_500, 11_000]);
  assert.deepEqual(actualRequestStarts.map((start, index) => index ? start - actualRequestStarts[index - 1] : null), [null, 20_375, 20_125]);
  assert(actualRequestStarts.slice(1).every((start, index) => start - actualRequestStarts[index] >= 20_000));
});

test('saved target context copies only whitelisted fields from the actual matching user turn', () => {
  const messages = [
    { id: 'old-turn', role: 'user', content: 'same prompt', createdAt: 10, deskContext: 'old context', presented: ['old-object'] },
    { id: 'current-turn', role: 'user', content: 'same prompt', createdAt: 20, deskContext: 'current context', presented: ['fragment', 42], accessToken: 'must-not-copy', requestHeaders: { cookie: 'must-not-copy' } },
  ];
  assert.deepEqual(savedUserTurnContext(messages, 'same prompt'), {
    id: 'current-turn', createdAt: 20, deskContext: 'current context', presented: ['fragment'],
  });
  assert.equal(savedUserTurnContext(messages, 'different prompt'), null);
  assert.deepEqual(savedUserTurnContext([{ role: 'user', content: 'legacy prompt', unexpected: 'ignored' }], 'legacy prompt'), {});
});

test('atomic JSON checkpoints protect existing paths and preserve the last complete file on failed replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-eval-atomic-'));
  const output = join(directory, 'checkpoint.json');
  try {
    await writeFile(output, 'pre-existing', { flag: 'wx' });
    const protectedWriter = createAtomicJsonWriter(output);
    await assert.rejects(protectedWriter('{"replacement":true}\n'), error => error.code === 'EEXIST');
    assert.equal(await readFile(output, 'utf8'), 'pre-existing');

    const ownedOutput = join(directory, 'owned.json');
    let failBeforeReplace = false;
    const writer = createAtomicJsonWriter(ownedOutput, {
      beforeReplace: async ({ initial }) => {
        if (!initial && failBeforeReplace) throw Object.assign(new Error('simulated interruption'), { code: 'SIMULATED_INTERRUPTION' });
      },
    });
    const first = { complete: true, version: 1 };
    await writer(`${JSON.stringify(first)}\n`);
    failBeforeReplace = true;
    await assert.rejects(writer('{"complete":false}\n'), error => error.code === 'SIMULATED_INTERRUPTION');
    assert.deepEqual(JSON.parse(await readFile(ownedOutput, 'utf8')), first);
    assert.deepEqual((await readdir(directory)).sort(), ['checkpoint.json', 'owned.json']);

    failBeforeReplace = false;
    const finalized = { complete: true, version: 2 };
    const record = { kind: 'baseline', status: 'complete', updatedAt: '2026-10-15T00:00:00.000Z', transcriptHash: 'saved-transcript' };
    record.recordHash = evaluationRecordHash(record);
    await writer(`${JSON.stringify({ ...finalized, record })}\n`);
    const saved = JSON.parse(await readFile(ownedOutput, 'utf8'));
    assert.deepEqual(saved, { ...finalized, record });
    assert.equal(saved.record.recordHash, evaluationRecordHash(saved.record));
    assert.deepEqual((await readdir(directory)).sort(), ['checkpoint.json', 'owned.json']);
  } finally {
    const entries = await readdir(directory);
    for (const entry of entries) await unlink(join(directory, entry));
    await rmdir(directory);
  }
});
