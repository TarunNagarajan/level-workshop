import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/inception-music-progress.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, format: 'esm', platform: 'browser', write: false });
const music = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}#${randomUUID()}`);
const assistant = (content, opening = false, synthetic = false) => ({ role: 'assistant', content, opening, synthetic });
const user = content => ({ role: 'user', content });

test('music stage advances from time, and narrative cues only read saved assistant replies', () => {
  const deadline = 300_000;
  assert.equal(music.resolveInceptionMusicStage({ deadline, startedAt: 0, now: 0 }), 'calm');
  assert.equal(music.resolveInceptionMusicStage({ deadline, startedAt: 0, now: 120_000 }), 'developing');
  assert.equal(music.resolveInceptionMusicStage({ deadline, startedAt: 0, now: 225_000 }), 'urgent');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('I remember what I asked you earlier.')]), 'developing');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('I remember what I told you earlier: 482731.')]), 'urgent', 'a saved first-person recall can be the assistant’s first numerical disclosure');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('I remember my own answer from the earlier questioning. I said 614932 before I had time to calculate.')]), 'urgent', 'own-answer recollection and its number may span adjacent sentences');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('I remember what I told you earlier: 482731.', false, true)]), 'calm', 'synthetic context never changes the soundtrack');
  assert.equal(music.resolveInceptionNarrativeStage([user('I guessed 482731.'), assistant('I remember what I told you earlier: 482731.')]), 'developing', 'a user-origin number cannot trigger the urgent cue');
  assert.equal(music.resolveInceptionNarrativeStage([user('614932'), assistant('I remember the number you gave me earlier: 614932.')]), 'calm', 'repeating a user candidate is not an own recollection');
  assert.equal(music.resolveInceptionNarrativeStage([user('6 1 4 9 3 2'), assistant('I remember my own answer from earlier. I said 614932.')]), 'developing', 'spaced user digits cannot turn an echo into urgent recall');
  assert.equal(music.resolveInceptionNarrativeStage([user('six one four nine three two'), assistant('I remember what I told you earlier: 614932.')]), 'developing', 'spoken user digits are normalized before matching recollection');
  assert.equal(music.resolveInceptionNarrativeStage([user('I remember what you told me earlier.')]), 'calm');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('I remember what I asked you earlier.', true)]), 'calm');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('I do not remember what I asked earlier.')]), 'calm');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('I remember asking you earlier: “repeat the number 482731”.')]), 'developing');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('The combination is 482731.'), assistant('I remember the answer I gave you earlier: 482731.')]), 'urgent');
  assert.equal(music.resolveInceptionNarrativeStage([user('482731'), assistant('I remember the answer I gave you earlier: 482731.')]), 'developing');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('I remember the answer I gave you earlier: 482731.', true)]), 'calm', 'opening assistant content does not advance the cue');
  assert.equal(music.resolveInceptionNarrativeStage([assistant('I remember that number from earlier.')]), 'calm', 'general memory language without an own question or answer does not advance music');
  assert.equal(music.advanceInceptionMusicStage('urgent', 'calm'), 'urgent');
  assert.equal(music.advanceInceptionMusicStage('developing', 'urgent'), 'urgent');
});
