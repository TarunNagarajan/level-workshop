export type InceptionAudioManifest = { approvedTrack?: string | null; roomTone?: string | null };

export class InceptionAudio {
  private context: AudioContext | null = null;
  private element: HTMLAudioElement | null = null;
  private gain: GainNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private timer = 0;
  private deadline = 0;
  private volume = 0.55;
  private muted = false;
  private disposed = false;
  private onVisibility = () => { if (document.hidden) void this.element?.pause(); else if (this.element && !this.disposed && !this.muted) { this.syncPosition(); void this.element.play().catch(() => undefined); } };

  async start(trackPath: string, deadline: number) {
    if (this.disposed || !trackPath) return false;
    this.deadline = deadline;
    if (!this.element) {
      this.context = new AudioContext();
      this.element = new Audio();
      this.element.preload = 'auto';
      this.element.loop = true;
      this.element.src = trackPath;
      this.source = this.context.createMediaElementSource(this.element);
      this.gain = this.context.createGain();
      this.gain.gain.setValueAtTime(0, this.context.currentTime);
      this.source.connect(this.gain).connect(this.context.destination);
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.scheduleGain();
    if (this.muted || document.hidden) return false;
    try {
      await this.context?.resume();
      this.syncPosition();
      await this.element.play();
      return true;
    } catch { return false; }
  }

  setDeadline(deadline: number) { this.deadline = deadline; this.scheduleGain(); }
  setVolume(value: number) { this.volume = Math.max(0, Math.min(0.7, value)); this.scheduleGain(); }
  setMuted(value: boolean) {
    this.muted = value;
    if (value) void this.element?.pause();
    else if (!document.hidden) { this.syncPosition(); void this.element?.play().catch(() => undefined); }
    this.scheduleGain();
  }
  get isMuted() { return this.muted; }
  get currentVolume() { return this.volume; }
  get isPlaying() { return Boolean(this.element && !this.element.paused && !this.element.ended); }
  async dispose(fade = true) {
    this.disposed = true; window.clearInterval(this.timer); document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.gain && this.context && fade) { this.gain.gain.cancelScheduledValues(this.context.currentTime); this.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.25); await new Promise(resolve => setTimeout(resolve, 800)); }
    this.element?.pause(); this.element?.removeAttribute('src'); this.element?.load();
    await this.context?.close().catch(() => undefined);
    this.element = null; this.gain = null; this.source = null; this.context = null;
  }
  private syncPosition() {
    if (!this.element || !Number.isFinite(this.element.duration) || this.element.duration <= 0) return;
    const elapsed = Math.max(0, Date.now() - (this.deadline - 300000)) / 1000;
    this.element.currentTime = elapsed % this.element.duration;
  }
  private scheduleGain() {
    if (!this.gain || !this.context) return;
    window.clearInterval(this.timer);
    const update = () => {
      if (!this.gain || !this.context) return;
      const remaining = Math.max(0, this.deadline - Date.now()) / 300000;
      const progress = 1 - remaining;
      const envelope = progress <= 0.6 ? 0.6 : progress >= 0.85 ? 1 : 0.6 + ((progress - 0.6) / 0.25) * 0.4;
      const target = this.muted ? 0 : Math.min(0.7, this.volume * envelope);
      this.gain.gain.cancelScheduledValues(this.context.currentTime);
      this.gain.gain.setTargetAtTime(target, this.context.currentTime, 0.9);
    };
    update(); this.timer = window.setInterval(update, 1500);
  }
}
