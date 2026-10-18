import type { InceptionMusicStage } from './inception-music-progress';

export type InceptionAudioManifest = {
  approvedTrack?: string | null;
  roomTone?: string | null;
  musicCues?: Partial<Record<InceptionMusicStage, string | null>>;
  creditsCue?: string | null;
};

type Deck = {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  path: string | null;
};

const stageOrder: Record<InceptionMusicStage, number> = { calm: 0, developing: 1, urgent: 2 };
const crossfadeSeconds = 3;
const roundDurationMs = 300_000;

export class InceptionAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private decks: Deck[] = [];
  private currentDeck = 0;
  private timer = 0;
  private transitionTimer = 0;
  private transitionResolve: (() => void) | null = null;
  private deadline = 0;
  private volume = 0.55;
  private muted = false;
  private disposed = false;
  private stage: InceptionMusicStage = 'calm';
  private manifest: InceptionAudioManifest = {};
  private transitionGeneration = 0;
  private playbackGeneration = 0;
  private transitionPromise: Promise<boolean> | null = null;
  private silentForFilm = false;
  private resolved = false;
  private creditsPending = false;
  private creditsMode = false;
  private creditsStarted = false;
  private creditsDeckIndex: number | null = null;
  private delays = new Map<number, () => void>();
  private onVisibility = () => {
    if (document.hidden) {
      for (const deck of this.decks) void deck.element.pause();
      return;
    }
    this.updateClockStage();
    if (this.creditsMode) {
      if (this.creditsPending) { void this.playCredits(); return; }
      const credits = this.creditsDeckIndex === null ? null : this.decks[this.creditsDeckIndex];
      if (credits && !this.disposed && !this.muted && !credits.element.ended) void this.context?.resume().then(() => credits.element.play()).catch(() => undefined);
      return;
    }
    if (this.creditsPending) { void this.playCredits(); return; }
    const current = this.decks[this.currentDeck];
    const desiredPath = this.pathFor(this.stage);
    if (current && desiredPath && current.path !== desiredPath && !this.silentForFilm && !this.resolved) { void this.crossfadeTo(desiredPath); return; }
    if (current && !this.disposed && !this.muted && !this.silentForFilm && !this.resolved) {
      this.syncPosition(current);
      void this.context?.resume().then(() => current.element.play()).catch(() => undefined);
    }
  };

  async start(manifest: InceptionAudioManifest | string, deadline: number, stage: InceptionMusicStage = 'calm') {
    if (this.disposed) return false;
    const generation = ++this.playbackGeneration;
    this.manifest = typeof manifest === 'string' ? { approvedTrack: manifest } : manifest;
    this.deadline = deadline;
    this.stage = stage;
    const path = this.pathFor(stage);
    if (!path) return false;
    if (!this.context) this.createGraph();
    const existing = this.decks[this.currentDeck];
    const deck = existing?.path === path ? existing : this.decks[0];
    this.currentDeck = this.decks.indexOf(deck);
    if (!this.prepareDeck(deck, path)) return false;
    const now = this.context!.currentTime;
    deck.gain.gain.cancelScheduledValues(now);
    deck.gain.gain.setValueAtTime(1, now);
    this.scheduleMasterGain();
    deck.element.loop = true;
    this.preloadNextStage();
    if (this.muted || document.hidden) return false;
    try {
      await this.context?.resume();
      if (this.disposed || generation !== this.playbackGeneration) return false;
      this.syncPosition(deck);
      await deck.element.play();
      if (this.disposed || generation !== this.playbackGeneration) { deck.element.pause(); return false; }
      return true;
    } catch {
      const fallback = this.manifest.roomTone;
      if (!fallback || fallback === path || this.disposed) return false;
      this.prepareDeck(deck, fallback);
      deck.gain.gain.cancelScheduledValues(this.context?.currentTime || 0);
      deck.gain.gain.setValueAtTime(1, this.context?.currentTime || 0);
      this.scheduleMasterGain();
      this.syncPosition(deck);
      try { await deck.element.play(); return true; } catch { return false; }
    }
  }

  setDeadline(deadline: number) {
    this.deadline = deadline;
    this.updateClockStage();
    this.scheduleMasterGain();
  }

  async setStage(next: InceptionMusicStage) {
    if (this.disposed) return;
    if (stageOrder[next] > stageOrder[this.stage]) this.stage = next;
    if (this.creditsMode) return;
    if (this.transitionPromise) await this.transitionPromise;
    const path = this.pathFor(this.stage);
    if (path && this.context && !this.muted && !this.silentForFilm && !this.resolved && !document.hidden && this.decks[this.currentDeck]?.path !== path) await this.crossfadeTo(path);
    this.scheduleMasterGain();
  }

  async fadeForFilm() {
    if (!this.context || !this.master || this.disposed) return;
    const generation = ++this.playbackGeneration;
    this.silentForFilm = true;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 0.9);
    await this.wait(950);
    if (this.disposed || generation !== this.playbackGeneration) return;
    for (const deck of this.decks) deck.element.pause();
  }

  async prepareCreditsCue() {
    if (!this.context || this.disposed || !this.manifest.creditsCue) return false;
    if (this.transitionPromise) await this.transitionPromise;
    if (this.disposed) return false;
    const index = 1 - this.currentDeck;
    const deck = this.decks[index];
    if (!deck) return false;
    this.prepareDeck(deck, this.manifest.creditsCue, false);
    deck.element.preload = 'auto';
    this.creditsDeckIndex = index;
    return true;
  }

  async resumeForCredits() {
    if (!this.context || !this.master || this.disposed) return false;
    const restart = !this.creditsMode || this.resolved;
    this.playbackGeneration++;
    this.silentForFilm = false;
    this.resolved = false;
    if (restart) {
      this.creditsMode = true;
      this.creditsPending = true;
      this.creditsStarted = false;
    }
    if (this.creditsDeckIndex === null) await this.prepareCreditsCue();
    if (this.muted || document.hidden) return false;
    if (this.creditsStarted) return true;
    return this.playCredits();
  }

  private async playCredits() {
    if (!this.context || !this.master || this.disposed || this.muted || document.hidden) return false;
    const generation = this.playbackGeneration;
    let index = this.creditsDeckIndex;
    if (index === null || !this.decks[index] || this.decks[index].path !== this.manifest.creditsCue) {
      if (!await this.prepareCreditsCue()) return false;
      index = this.creditsDeckIndex;
    }
    if (index === null) return false;
    const deck = this.decks[index];
    try {
      await this.context.resume();
      if (this.disposed || generation !== this.playbackGeneration) return false;
      if (!this.creditsStarted || deck.element.ended) deck.element.currentTime = 0;
      await deck.element.play();
      if (this.disposed || generation !== this.playbackGeneration) { deck.element.pause(); return false; }
      const now = this.context.currentTime;
      if (!this.creditsStarted) {
        deck.gain.gain.cancelScheduledValues(now);
        deck.gain.gain.setValueAtTime(0, now);
        deck.gain.gain.linearRampToValueAtTime(1, now + 1.2);
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(0, now);
        this.master.gain.linearRampToValueAtTime(Math.min(0.7, this.volume), now + 1.2);
      }
      const previous = this.decks[this.currentDeck];
      this.currentDeck = index;
      this.creditsPending = false;
      this.creditsStarted = true;
      if (previous !== deck) previous?.element.pause();
      return true;
    } catch { return false; }
  }

  async fadeToSilence(durationSeconds = 2.5) {
    if (!this.context || !this.master || this.disposed) return;
    const generation = ++this.playbackGeneration;
    this.resolved = true;
    this.creditsPending = false;
    this.creditsMode = false;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + durationSeconds);
    await this.wait(durationSeconds * 1000);
    if (this.disposed || generation !== this.playbackGeneration) return;
    for (const deck of this.decks) deck.element.pause();
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(0.7, value));
    this.scheduleMasterGain();
  }

  setMuted(value: boolean) {
    this.muted = value;
    if (value) {
      for (const deck of this.decks) void deck.element.pause();
    } else if (!document.hidden && this.creditsMode && !this.resolved) {
      if (this.creditsPending) void this.playCredits();
      else {
        const current = this.creditsDeckIndex === null ? null : this.decks[this.creditsDeckIndex];
        if (current && !current.element.ended) void this.context?.resume().then(() => current.element.play()).catch(() => undefined);
      }
    } else if (!document.hidden && !this.silentForFilm && !this.resolved) {
      const current = this.decks[this.currentDeck];
      const requestedPath = this.pathFor(this.stage);
      if (current && requestedPath !== current.path && requestedPath) {
        void this.crossfadeTo(requestedPath);
      } else if (current) {
        this.syncPosition(current);
        void this.context?.resume().then(() => current.element.play()).catch(() => undefined);
      }
    }
    this.scheduleMasterGain();
  }

  get isMuted() { return this.muted; }
  get currentVolume() { return this.volume; }
  get isInitialized() { return Boolean(this.context); }
  get isPlaying() { return this.decks.some(deck => !deck.element.paused && !deck.element.ended); }

  async dispose(fade = true) {
    if (this.disposed) return;
    this.disposed = true;
    this.playbackGeneration++;
    this.transitionGeneration++;
    window.clearInterval(this.timer);
    window.clearTimeout(this.transitionTimer);
    this.transitionResolve?.();
    this.transitionResolve = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const [timer, resolve] of this.delays) { window.clearTimeout(timer); resolve(); }
    this.delays.clear();
    if (this.master && this.context && fade) {
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(0, now + 0.65);
      await this.wait(700);
    }
    for (const deck of this.decks) {
      deck.element.pause();
      deck.element.removeAttribute('src');
      deck.element.load();
    }
    await this.context?.close().catch(() => undefined);
    this.decks = [];
    this.master = null;
    this.context = null;
    this.transitionPromise = null;
  }

  private createGraph() {
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.context.destination);
    this.decks = [0, 1].map(() => {
      const element = new Audio();
      element.preload = 'auto';
      element.loop = true;
      const source = this.context!.createMediaElementSource(element);
      const gain = this.context!.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.master!);
      return { element, source, gain, path: null };
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.timer = window.setInterval(() => {
      this.updateClockStage();
      this.scheduleMasterGain();
    }, 1000);
  }

  private pathFor(stage: InceptionMusicStage) {
    return this.manifest.musicCues?.[stage] || this.manifest.approvedTrack || this.manifest.roomTone || null;
  }

  private prepareDeck(deck: Deck, path: string, loop = true) {
    if (deck.path === path) { deck.element.loop = loop; return true; }
    deck.element.pause();
    deck.element.src = path;
    deck.element.loop = loop;
    deck.element.load();
    deck.path = path;
    deck.gain.gain.cancelScheduledValues(this.context?.currentTime || 0);
    deck.gain.gain.setValueAtTime(0, this.context?.currentTime || 0);
    return true;
  }

  private preloadNextStage() {
    if (this.stage === 'urgent') return;
    const next: InceptionMusicStage = this.stage === 'calm' ? 'developing' : 'urgent';
    const path = this.manifest.musicCues?.[next];
    if (path && this.decks[1 - this.currentDeck]) this.prepareDeck(this.decks[1 - this.currentDeck], path);
  }

  private async crossfadeTo(path: string) {
    if (this.transitionPromise) {
      const completed = await this.transitionPromise;
      if (!completed || this.disposed || this.decks[this.currentDeck]?.path === path) return completed;
    }
    const previous = this.decks[this.currentDeck];
    if (!previous || previous.path === path || !this.context || !this.master) return true;
    const generation = ++this.transitionGeneration;
    const targetIndex = 1 - this.currentDeck;
    const target = this.decks[targetIndex];
    this.prepareDeck(target, path);
    const transition = (async () => {
      try {
        await this.context!.resume();
        this.syncPosition(target);
        await target.element.play();
      } catch { return false; }
      if (this.disposed || generation !== this.transitionGeneration) { target.element.pause(); return false; }
      const now = this.context!.currentTime;
      for (const deck of [previous, target]) deck.gain.gain.cancelScheduledValues(now);
      previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
      target.gain.gain.setValueAtTime(target.gain.gain.value, now);
      previous.gain.gain.linearRampToValueAtTime(0, now + crossfadeSeconds);
      target.gain.gain.linearRampToValueAtTime(1, now + crossfadeSeconds);
      this.currentDeck = targetIndex;
      window.clearTimeout(this.transitionTimer);
      this.transitionTimer = window.setTimeout(() => {
        if (generation === this.transitionGeneration && previous !== this.decks[this.currentDeck]) {
          previous.element.pause();
          this.preloadNextStage();
        }
        this.transitionResolve?.();
        this.transitionResolve = null;
      }, crossfadeSeconds * 1000 + 100);
      await new Promise<void>(resolve => { this.transitionResolve = resolve; });
      if (this.disposed || generation !== this.transitionGeneration) return false;
      return true;
    })();
    this.transitionPromise = transition;
    try { return await transition; } finally { if (this.transitionPromise === transition) this.transitionPromise = null; }
  }

  private elapsedMs() { return Math.max(0, roundDurationMs - Math.max(0, this.deadline - Date.now())); }

  private updateClockStage() {
    if (this.disposed) return;
    const elapsed = this.elapsedMs();
    const next = elapsed >= 225_000 ? 'urgent' : elapsed >= 120_000 ? 'developing' : 'calm';
    if (stageOrder[next] > stageOrder[this.stage]) this.setStage(next);
  }

  private syncPosition(deck: Deck) {
    const seek = () => {
      if (Number.isFinite(deck.element.duration) && deck.element.duration > 0) {
        try { deck.element.currentTime = this.elapsedMs() / 1000 % deck.element.duration; } catch { /* metadata may still be settling */ }
      }
    };
    seek();
    if (!Number.isFinite(deck.element.duration) || deck.element.duration <= 0) deck.element.addEventListener('loadedmetadata', seek, { once: true });
  }

  private scheduleMasterGain() {
    if (!this.master || !this.context) return;
    const progress = Math.min(1, this.elapsedMs() / roundDurationMs);
    const envelope = 0.82 + 0.18 * progress;
    const target = this.muted || this.silentForFilm || this.resolved ? 0 : Math.min(0.7, this.volume * envelope);
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(target, now, 0.9);
  }

  private wait(milliseconds: number) {
    return new Promise<void>(resolve => {
      const timer = window.setTimeout(() => { this.delays.delete(timer); resolve(); }, milliseconds);
      this.delays.set(timer, resolve);
    });
  }
}
