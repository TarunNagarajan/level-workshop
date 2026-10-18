export type InceptionAudioManifest = {
  gameplayLoop?: string | null;
  roomTone?: string | null;
  creditsCue?: string | null;
};

type Deck = {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  path: string | null;
};

const gameplayDeckIndex = 0;
const creditsDeckIndex = 1;
const gameplayMix = 0.82;

export class InceptionAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private decks: Deck[] = [];
  private manifest: InceptionAudioManifest = {};
  private volume = 0.55;
  private muted = false;
  private disposed = false;
  private silentForFilm = false;
  private resolved = false;
  private creditsMode = false;
  private creditsPending = false;
  private creditsStarted = false;
  private delays = new Map<number, () => void>();
  private creditsWaiters = new Set<() => void>();
  private playbackGeneration = 0;

  private onVisibility = () => {
    if (document.hidden) {
      this.playbackGeneration++;
      for (const deck of this.decks) void deck.element.pause();
      return;
    }
    if (this.disposed || this.muted || this.silentForFilm || this.resolved) return;
    if (this.creditsMode && this.creditsPending) { void this.playCredits(); return; }
    const index = this.creditsMode ? creditsDeckIndex : gameplayDeckIndex;
    const current = this.decks[index];
    if (current && !current.element.ended) void this.resumeDeck(current).catch(() => undefined);
  };

  async start(manifest: InceptionAudioManifest | string) {
    if (this.disposed) return false;
    this.manifest = typeof manifest === 'string' ? { gameplayLoop: manifest } : manifest;
    const path = this.manifest.gameplayLoop || this.manifest.roomTone || null;
    if (!path) return false;
    if (!this.context) this.createGraph();
    const deck = this.decks[gameplayDeckIndex];
    if (!deck) return false;
    this.creditsMode = false;
    this.creditsPending = false;
    this.creditsStarted = false;
    this.silentForFilm = false;
    this.resolved = false;
    const generation = ++this.playbackGeneration;
    const alreadyPlaying = deck.path === path && !deck.element.paused;
    this.prepareDeck(deck, path, true);
    if (alreadyPlaying && !this.muted && !document.hidden) { this.scheduleMasterGain(); return true; }
    deck.gain.gain.cancelScheduledValues(this.context!.currentTime);
    deck.gain.gain.setValueAtTime(1, this.context!.currentTime);
    this.scheduleMasterGain();
    if (this.muted || document.hidden) return false;
    try {
      await this.resumeDeck(deck, generation);
      return !this.disposed && !deck.element.paused;
    } catch {
      if (generation !== this.playbackGeneration || !this.canPlayIntent(deck)) return false;
      const fallback = this.manifest.roomTone;
      if (!fallback || fallback === path || this.disposed) return false;
      this.prepareDeck(deck, fallback, true);
      deck.gain.gain.cancelScheduledValues(this.context?.currentTime || 0);
      deck.gain.gain.setValueAtTime(1, this.context?.currentTime || 0);
      this.scheduleMasterGain();
      try {
        await this.resumeDeck(deck, generation);
        return !this.disposed && !deck.element.paused;
      } catch { return false; }
    }
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
    const deck = this.decks[creditsDeckIndex];
    if (!deck) return false;
    this.prepareDeck(deck, this.manifest.creditsCue, false);
    deck.element.preload = 'auto';
    this.creditsStarted = false;
    return true;
  }

  async resumeForCredits() {
    if (!this.context || !this.master || this.disposed) return false;
    this.playbackGeneration++;
    this.silentForFilm = false;
    this.resolved = false;
    this.creditsMode = true;
    this.creditsPending = true;
    if (!this.manifest.creditsCue) return false;
    if (!this.decks[creditsDeckIndex]?.path || this.decks[creditsDeckIndex]?.path !== this.manifest.creditsCue) {
      if (!await this.prepareCreditsCue()) return false;
    }
    if (this.muted || document.hidden) return false;
    return this.playCredits();
  }

  private async playCredits() {
    if (!this.context || !this.master || this.disposed || this.muted || document.hidden) return false;
    const generation = this.playbackGeneration;
    const deck = this.decks[creditsDeckIndex];
    if (!deck || !this.manifest.creditsCue) return false;
    try {
      await this.context.resume();
      if (!this.canPlay(deck, generation)) return false;
      if (!this.creditsStarted || deck.element.ended) deck.element.currentTime = 0;
      await deck.element.play();
      if (!this.canPlay(deck, generation)) { deck.element.pause(); return false; }
      const now = this.context.currentTime;
      if (!this.creditsStarted) {
        deck.gain.gain.cancelScheduledValues(now);
        deck.gain.gain.setValueAtTime(0, now);
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(Math.min(0.7, this.volume), now);
      }
      this.creditsPending = false;
      this.creditsStarted = true;
      this.decks[gameplayDeckIndex]?.element.pause();
      return true;
    } catch { return false; }
  }

  fadeCreditsIn(durationSeconds: number) {
    const deck = this.decks[creditsDeckIndex];
    if (!this.context || !deck || this.disposed) return;
    const now = this.context.currentTime;
    deck.gain.gain.cancelScheduledValues(now);
    deck.gain.gain.setValueAtTime(deck.gain.gain.value, now);
    if (durationSeconds <= 0) {
      deck.gain.gain.setValueAtTime(1, now);
      return;
    }
    const frames = 65;
    const equalPowerIn = Float32Array.from({ length: frames }, (_, index) => Math.sin(index / (frames - 1) * Math.PI / 2));
    deck.gain.gain.setValueCurveAtTime(equalPowerIn, now, durationSeconds);
  }

  get creditsCurrentTime() { return this.decks[creditsDeckIndex]?.element.currentTime || 0; }

  waitForCreditsTime(targetSeconds: number) {
    const deck = this.decks[creditsDeckIndex];
    if (!deck || this.disposed) return Promise.resolve(false);
    if (deck.element.currentTime >= targetSeconds) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      let timer: number | null = null;
      const finish = (reached: boolean) => {
        if (timer !== null) window.clearTimeout(timer);
        this.creditsWaiters.delete(cancel);
        resolve(reached);
      };
      const cancel = () => finish(false);
      const check = () => {
        if (this.disposed || deck.element.ended) { finish(false); return; }
        if (deck.element.currentTime >= targetSeconds) { finish(true); return; }
        timer = window.setTimeout(check, 80);
      };
      this.creditsWaiters.add(cancel);
      check();
    });
  }

  waitForCreditsEnd() {
    const deck = this.decks[creditsDeckIndex];
    if (!deck || this.disposed) return Promise.resolve(false);
    if (deck.element.ended) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const finish = (ended: boolean) => {
        deck.element.removeEventListener('ended', onEnded);
        this.creditsWaiters.delete(cancel);
        resolve(ended);
      };
      const onEnded = () => finish(true);
      const cancel = () => finish(false);
      this.creditsWaiters.add(cancel);
      deck.element.addEventListener('ended', onEnded, { once: true });
    });
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(0.7, value));
    this.scheduleMasterGain();
  }

  setMuted(value: boolean) {
    if (this.muted !== value) this.playbackGeneration++;
    this.muted = value;
    if (value) {
      for (const deck of this.decks) void deck.element.pause();
    } else if (!document.hidden && !this.silentForFilm && !this.resolved) {
      if (this.creditsMode && this.creditsPending) void this.playCredits();
      else {
        const deck = this.decks[this.creditsMode ? creditsDeckIndex : gameplayDeckIndex];
        if (deck && !deck.element.ended) void this.resumeDeck(deck).catch(() => undefined);
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
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const [timer, resolve] of this.delays) { window.clearTimeout(timer); resolve(); }
    this.delays.clear();
    for (const cancel of [...this.creditsWaiters]) cancel();
    this.creditsWaiters.clear();
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
  }

  private prepareDeck(deck: Deck, path: string, loop: boolean) {
    if (deck.path === path) { deck.element.loop = loop; return; }
    deck.element.pause();
    deck.element.src = path;
    deck.element.loop = loop;
    deck.element.load();
    deck.path = path;
    deck.gain.gain.cancelScheduledValues(this.context?.currentTime || 0);
    deck.gain.gain.setValueAtTime(0, this.context?.currentTime || 0);
  }

  private async resumeDeck(deck: Deck, generation = this.playbackGeneration) {
    if (!this.context) return false;
    if (!this.canPlay(deck, generation)) return false;
    await this.context.resume();
    if (!this.canPlay(deck, generation)) return false;
    await deck.element.play();
    if (!this.canPlayIntent(deck)) { deck.element.pause(); return false; }
    return generation === this.playbackGeneration ? true : !deck.element.paused;
  }

  private canPlayIntent(deck: Deck) {
    const expectedIndex = this.creditsMode ? creditsDeckIndex : gameplayDeckIndex;
    return !this.disposed && !this.muted && !document.hidden && !this.silentForFilm && !this.resolved && this.decks[expectedIndex] === deck;
  }

  private canPlay(deck: Deck, generation: number) {
    return generation === this.playbackGeneration && this.canPlayIntent(deck);
  }

  private scheduleMasterGain() {
    if (!this.master || !this.context) return;
    const target = this.muted || this.silentForFilm || this.resolved ? 0 : Math.min(0.7, this.volume * (this.creditsMode ? 1 : gameplayMix));
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
