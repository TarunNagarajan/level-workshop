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
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(['target', value, time, constant]); }
}
class FakeNode {
  static created = [];
  connections = [];
  constructor() { this.gain = new FakeAudioParam(); FakeNode.created.push(this); }
  connect(node) { this.connections.push(node); return node; }
}
class FakeContext {
  currentTime = 0;
  destination = {};
  closed = false;
  createGain() { return new FakeNode(); }
  createMediaElementSource(element) { return { element, connect: node => node }; }
  async resume() {}
  async close() { this.closed = true; }
}
class FakeMedia {
  static created = [];
  static fail = new Set();
  src = '';
  loop = true;
  preload = '';
  currentTime = 0;
  duration = 40;
  paused = true;
  ended = false;
  listeners = new Map();
  constructor() { FakeMedia.created.push(this); }
  load() {}
  async play() { if (FakeMedia.fail.has(this.src)) throw new Error('fixture playback failure'); this.paused = false; return undefined; }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const doc = {
  hidden: false,
  listeners: new Map(),
  addEventListener(name, listener) { this.listeners.set(name, listener); },
  removeEventListener(name) { this.listeners.delete(name); },
  fire(name) { this.listeners.get(name)?.(); },
};

test('staged audio serializes crossfades, reconciles hidden stages, hands off to credits, and disposes', async () => {
  const original = { Audio: globalThis.Audio, AudioContext: globalThis.AudioContext, document: globalThis.document, window: globalThis.window };
  globalThis.Audio = FakeMedia;
  globalThis.AudioContext = FakeContext;
  globalThis.document = doc;
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval };
  FakeMedia.created = [];
  FakeMedia.fail = new Set();
  FakeNode.created = [];
  const instance = new audioModule.InceptionAudio();
  const manifest = { musicCues: { calm: '/calm.mp3', developing: '/developing.mp3', urgent: '/urgent.mp3' }, creditsCue: '/credits.mp3', roomTone: '/room.mp3' };
  try {
    instance.setVolume(0.4);
    assert.equal(await instance.start(manifest, Date.now() + 300_000, 'calm'), true);
    assert.equal(instance.isPlaying, true);

    const developing = instance.setStage('developing');
    await wait(80);
    const urgent = instance.setStage('urgent');
    await Promise.all([developing, urgent]);
    assert.ok(FakeMedia.created.some(deck => deck.src === '/urgent.mp3' && !deck.paused));
    assert.equal(FakeMedia.created.filter(deck => !deck.paused).length, 1, 'only one cue deck plays after the queued fades settle');
    const outgoing = FakeNode.created[1].gain.events.filter(event => event[0] === 'ramp');
    const incoming = FakeNode.created[2].gain.events.filter(event => event[0] === 'ramp');
    assert.equal(outgoing.at(-1)[1] + incoming.at(-1)[1], 1, 'crossfade ends with complementary deck gains');
    assert.equal(outgoing.at(-1)[2], incoming.at(-1)[2], 'both deck ramps share the same end time');

    doc.hidden = true;
    doc.fire('visibilitychange');
    instance.setStage('calm');
    instance.setDeadline(Date.now() + 70_000);
    assert.equal(FakeMedia.created.filter(deck => !deck.paused).length, 0, 'hidden pages pause every deck');
    doc.hidden = false;
    doc.fire('visibilitychange');
    await wait(3_200);
    assert.ok(FakeMedia.created.some(deck => deck.src === '/urgent.mp3' && !deck.paused), 'resume reconciles to the forward-only urgent stage');
    assert.equal(FakeMedia.created.filter(deck => !deck.paused).length, 1);

    assert.equal(await instance.prepareCreditsCue(), true);
    await instance.fadeForFilm();
    assert.equal(instance.isPlaying, false, 'the workshop score is silent before the native film');
    assert.equal(await instance.resumeForCredits(), true);
    const credits = FakeMedia.created.find(deck => deck.src === '/credits.mp3');
    assert.ok(credits && !credits.loop && !credits.paused, 'credits use the dedicated non-looping cue');
    await instance.setStage('calm');
    assert.equal(FakeMedia.created.filter(deck => !deck.paused).length, 1);

    instance.setMuted(true);
    assert.equal(instance.isPlaying, false);
    instance.setMuted(false);
    await wait(20);
    assert.ok(credits && !credits.paused, 'unmuting resumes the credits cue instead of returning to a stage loop');
    const staleFade = instance.fadeToSilence(0.03);
    await wait(5);
    assert.equal(await instance.resumeForCredits(), true, 'a deliberate restart invalidates an earlier ending fade');
    await staleFade;
    assert.ok(credits && !credits.paused, 'an aborted fade cannot pause the restarted credits cue');
    await instance.fadeToSilence(0.01);
    assert.equal(instance.isPlaying, false);
    await instance.dispose(false);
    assert.equal(doc.listeners.size, 0, 'visibility listener is removed');
    assert.equal(FakeMedia.created.every(deck => deck.src === ''), true, 'media sources are cleared on disposal');
  } finally {
    doc.hidden = false;
    if (!instance.isMuted) await instance.dispose(false);
    globalThis.Audio = original.Audio;
    globalThis.AudioContext = original.AudioContext;
    globalThis.document = original.document;
    globalThis.window = original.window;
  }
});

test('room-tone fallback remains audible after a stage asset rejects playback', async () => {
  const original = { Audio: globalThis.Audio, AudioContext: globalThis.AudioContext, document: globalThis.document, window: globalThis.window };
  globalThis.Audio = FakeMedia;
  globalThis.AudioContext = FakeContext;
  globalThis.document = doc;
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval };
  FakeMedia.created = [];
  FakeMedia.fail = new Set(['/calm.mp3']);
  doc.hidden = false;
  FakeNode.created = [];
  const instance = new audioModule.InceptionAudio();
  try {
    assert.equal(await instance.start({ musicCues: { calm: '/calm.mp3' }, roomTone: '/room.mp3' }, Date.now() + 300_000), true);
    const fallback = FakeMedia.created.find(deck => deck.src === '/room.mp3');
    assert.ok(fallback && !fallback.paused);
    assert.equal(FakeNode.created[1].gain.value, 1, 'fallback deck is restored to audible gain after replacing the failed cue');
  } finally {
    doc.hidden = false;
    await instance.dispose(false);
    globalThis.Audio = original.Audio;
    globalThis.AudioContext = original.AudioContext;
    globalThis.document = original.document;
    globalThis.window = original.window;
    FakeMedia.fail = new Set();
  }
});
