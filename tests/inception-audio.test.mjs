import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/inception-audio.ts', import.meta.url));
const compiled = await build({ entryPoints: [source], bundle: true, format: 'esm', platform: 'browser', write: false });
const audioModule = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}#${randomUUID()}`);

class FakeAudioParam {
  value = 0;
  events = [];
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
  setValueCurveAtTime(values, time, duration) { this.value = values.at(-1); this.events.push(['curve', Array.from(values), time, duration]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(['target', value, time, constant]); }
}
class FakeNode {
  static created = [];
  connections = [];
  constructor() { this.gain = new FakeAudioParam(); FakeNode.created.push(this); }
  connect(node) { this.connections.push(node); return node; }
}
class FakeContext {
  static resumeGate = null;
  currentTime = 0;
  destination = {};
  closed = false;
  createGain() { return new FakeNode(); }
  createMediaElementSource(element) { return { element, connect: node => node }; }
  async resume() { if (FakeContext.resumeGate) await FakeContext.resumeGate; }
  async close() { this.closed = true; }
}
class FakeMedia {
  static created = [];
  static fail = new Set();
  static playGate = null;
  src = '';
  loop = true;
  preload = '';
  currentTime = 0;
  duration = 128;
  paused = true;
  ended = false;
  loadCount = 0;
  playCount = 0;
  listeners = new Map();
  constructor() { FakeMedia.created.push(this); }
  load() { this.loadCount++; }
  async play() { this.playCount++; if (FakeMedia.playGate) await FakeMedia.playGate; if (FakeMedia.fail.has(this.src)) throw new Error('fixture playback failure'); this.paused = false; return undefined; }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  dispatch(name) { this.listeners.get(name)?.(); }
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const doc = {
  hidden: false,
  listeners: new Map(),
  addEventListener(name, listener) { this.listeners.set(name, listener); },
  removeEventListener(name) { this.listeners.delete(name); },
  fire(name) { this.listeners.get(name)?.(); },
};
const setup = () => {
  const original = { Audio: globalThis.Audio, AudioContext: globalThis.AudioContext, document: globalThis.document, window: globalThis.window };
  globalThis.Audio = FakeMedia;
  globalThis.AudioContext = FakeContext;
  globalThis.document = doc;
  globalThis.window = { setTimeout, clearTimeout };
  FakeMedia.created = [];
  FakeMedia.fail = new Set();
  FakeMedia.playGate = null;
  FakeContext.resumeGate = null;
  FakeNode.created = [];
  doc.hidden = false;
  return original;
};
const restore = async (original, instance) => {
  doc.hidden = false;
  await instance.dispose(false);
  globalThis.Audio = original.Audio;
  globalThis.AudioContext = original.AudioContext;
  globalThis.document = original.document;
  globalThis.window = original.window;
};

test('one gameplay loop stays on its current position across playback, mute, visibility, and repeated start requests', async () => {
  const original = setup();
  const instance = new audioModule.InceptionAudio();
  const manifest = { gameplayLoop: '/gameplay-loop-v1.mp3', creditsCue: '/credits.mp3', roomTone: '/room.mp3' };
  try {
    instance.setVolume(0.4);
    assert.equal(await instance.start(manifest), true);
    assert.equal(typeof instance.setStage, 'undefined', 'the runtime has no adaptive stage API');
    assert.equal(typeof instance.setDeadline, 'undefined', 'the runtime has no countdown-linked audio API');
    assert.equal(FakeMedia.created.length, 2, 'one persistent gameplay deck and one credits standby deck are created');
    const gameplay = FakeMedia.created[0];
    assert.equal(gameplay.src, manifest.gameplayLoop);
    assert.equal(gameplay.loop, true);
    assert.equal(FakeMedia.created[1].src, '', 'credits do not replace or preload over the gameplay deck');
    const initialGain = FakeNode.created[0].gain.events.findLast(event => event[0] === 'target');
    assert.equal(initialGain[1], 0.4 * 0.82, 'gameplay uses one fixed mix multiplied by the saved user volume');

    gameplay.currentTime = 31.8;
    const loads = gameplay.loadCount;
    await instance.start(manifest);
    assert.equal(gameplay.loadCount, loads, 'repeated start does not reload the initialized gameplay asset');
    assert.equal(gameplay.currentTime, 31.8, 'repeated start does not seek the current musical position');

    instance.setMuted(true);
    assert.equal(gameplay.paused, true);
    instance.setMuted(false);
    await wait(5);
    assert.equal(gameplay.paused, false);
    assert.equal(gameplay.currentTime, 31.8, 'unmuting resumes at the existing playback position');

    gameplay.currentTime = 32.2;
    doc.hidden = true;
    doc.fire('visibilitychange');
    assert.equal(gameplay.paused, true);
    doc.hidden = false;
    doc.fire('visibilitychange');
    await wait(5);
    assert.equal(gameplay.paused, false);
    assert.equal(gameplay.currentTime, 32.2, 'tab resume does not seek from elapsed wall-clock time');

    await instance.prepareCreditsCue();
    assert.equal(FakeMedia.created[1].src, manifest.creditsCue);
    assert.equal(FakeMedia.created[1].loop, false);
    assert.equal(FakeMedia.created[1].playCount, 0, 'the credits deck remains in standby during gameplay');
    assert.equal(gameplay.src, manifest.gameplayLoop, 'no reply or elapsed-time operation can swap the gameplay path');
    const volumeTargetEvents = FakeNode.created[0].gain.events.filter(event => event[0] === 'target').length;
    await wait(20);
    assert.equal(FakeNode.created[0].gain.events.filter(event => event[0] === 'target').length, volumeTargetEvents, 'no clock-driven gain ramp runs in the background');

    await instance.fadeForFilm();
    assert.equal(instance.isPlaying, false, 'gameplay score is silent before the approved film');
    assert.equal(await instance.resumeForCredits(), true);
    const credits = FakeMedia.created[1];
    assert.ok(!credits.loop && !credits.paused, 'credits start on their dedicated nonlooping deck');
    assert.equal(FakeNode.created[2].gain.events.at(-1)[1], 0, 'the pre-rolled credits deck remains silent until the final quarter-second');
    const masterEventsAtHandoff = FakeNode.created[0].gain.events;
    assert.deepEqual(masterEventsAtHandoff.at(-1).slice(0, 2), ['set', 0.4], 'the master opens directly at the saved volume while the credits deck starts at zero');
    assert.equal(masterEventsAtHandoff.some(event => event[0] === 'ramp' && event[1] > 0), false, 'there is no second master fade-in during the handoff');
    instance.fadeCreditsIn(0.25);
    const handoffCurve = FakeNode.created[2].gain.events.findLast(event => event[0] === 'curve');
    assert.equal(handoffCurve[1].length, 65, 'credits use one sampled equal-power ramp');
    assert.equal(handoffCurve[1][0], 0);
    assert.equal(handoffCurve[1].at(-1), 1);
    assert.equal(handoffCurve[3], 0.25, 'the audible tail fade shares the final-quarter-second native-video fade');
    credits.currentTime = 4.25;
    instance.setMuted(true);
    assert.equal(credits.paused, true);
    instance.setMuted(false);
    await wait(5);
    assert.equal(credits.paused, false);
    assert.equal(credits.currentTime, 4.25, 'unmuting resumes credits at their current position');

    const completed = instance.waitForCreditsEnd();
    credits.ended = true;
    credits.dispatch('ended');
    assert.equal(await completed, true, 'the natural tail end is observable for terminal cleanup');
    await instance.dispose(false);
    assert.equal(doc.listeners.size, 0, 'visibility listener is removed');
    assert.equal(FakeMedia.created.every(deck => deck.src === ''), true, 'media sources are cleared on disposal');
  } finally {
    globalThis.Audio = original.Audio;
    globalThis.AudioContext = original.AudioContext;
    globalThis.document = original.document;
    globalThis.window = original.window;
  }
});

test('room-tone fallback remains audible when the gameplay asset rejects playback', async () => {
  const original = setup();
  const instance = new audioModule.InceptionAudio();
  FakeMedia.fail = new Set(['/gameplay-loop-v1.mp3']);
  try {
    assert.equal(await instance.start({ gameplayLoop: '/gameplay-loop-v1.mp3', roomTone: '/room.mp3' }), true);
    const fallback = FakeMedia.created[0];
    assert.equal(fallback.src, '/room.mp3');
    assert.ok(!fallback.paused);
    assert.equal(FakeNode.created[1].gain.value, 1, 'fallback deck is restored to audible gain after replacing the failed music');
  } finally {
    await restore(original, instance);
  }
});

test('a mute or hidden-tab change during deferred autoplay cancels the stale play', async () => {
  const original = setup();
  const instance = new audioModule.InceptionAudio();
  let finishResume;
  FakeContext.resumeGate = new Promise(resolve => { finishResume = resolve; });
  try {
    const starting = instance.start({ gameplayLoop: '/gameplay-loop-v1.mp3', roomTone: '/room.mp3' });
    await wait(0);
    doc.hidden = true;
    doc.fire('visibilitychange');
    finishResume();
    assert.equal(await starting, false);
    assert.equal(FakeMedia.created[0].playCount, 0, 'visibility change during context.resume prevents playback from starting');
    assert.equal(FakeMedia.created[0].paused, true);
  } finally {
    FakeContext.resumeGate = null;
    await restore(original, instance);
  }

  const secondOriginal = setup();
  const second = new audioModule.InceptionAudio();
  let finishPlay;
  FakeMedia.playGate = new Promise(resolve => { finishPlay = resolve; });
  try {
    const starting = second.start({ gameplayLoop: '/gameplay-loop-v1.mp3', roomTone: '/room.mp3' });
    await wait(0);
    second.setMuted(true);
    finishPlay();
    assert.equal(await starting, false);
    assert.equal(FakeMedia.created[0].paused, true, 'mute while play() is pending pauses the stale media start after it resolves');
  } finally {
    FakeMedia.playGate = null;
    await restore(secondOriginal, second);
  }
});

test('an aborted old play cannot replace a newer unmuted gameplay start with room tone', async () => {
  const original = setup();
  const instance = new audioModule.InceptionAudio();
  let rejectOldPlay;
  FakeMedia.playGate = new Promise((_, reject) => { rejectOldPlay = reject; });
  try {
    const staleStart = instance.start({ gameplayLoop: '/gameplay-loop-v1.mp3', roomTone: '/room.mp3' });
    await wait(0);
    instance.setMuted(true);
    FakeMedia.playGate = null;
    instance.setMuted(false);
    await wait(0);
    const gameplay = FakeMedia.created[0];
    assert.equal(gameplay.src, '/gameplay-loop-v1.mp3');
    assert.equal(gameplay.paused, false, 'the newer unmute request starts the intended score');
    rejectOldPlay(new DOMException('Playback interrupted by pause', 'AbortError'));
    assert.equal(await staleStart, false, 'the superseded start reports that it did not own the current playback');
    await wait(0);
    assert.equal(gameplay.src, '/gameplay-loop-v1.mp3', 'the stale catch path does not swap in fallback room tone');
    assert.equal(gameplay.paused, false, 'the stale catch path does not pause the valid newer playback');
    assert.equal(FakeMedia.created[1].src, '', 'fallback deck remains untouched');
  } finally {
    FakeMedia.playGate = null;
    await restore(original, instance);
  }
});
