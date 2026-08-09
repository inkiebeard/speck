import * as THREE from 'three';

export interface SoundSystemOptions {
  /** Where to listen for the first user gesture that resumes the `AudioContext`. Default `window`. */
  gestureTarget?: EventTarget;
  /** Max concurrently playing voices before a lower-priority one is stolen to make room. */
  maxVoices?: number;
  /** Max requests waiting in queue before a lower-priority one is evicted to make room. Bounds how backed-up the queue can get during a sustained burst — without this, `queueTTL` only bounds how stale any *one* request can be, not how many can be queued at once, so a burst that outpaces `maxVoices` for its whole duration keeps the queue permanently full and trickles out stale-ish plays the entire time. */
  maxQueueLength?: number;
  /** Whether to wire a master `DynamicsCompressorNode` onto all listener output (see the class doc). Default `true`. Set `false` to opt out — e.g. if a project wants to manage its own master bus via `listener.setFilter`, since that call replaces whatever filter is already set, including this one. */
  limiter?: boolean;
}

export interface PlayOptions {
  /** 0–1. Default 1. */
  volume?: number;
  /** Higher wins contention: voice stealing and queue draining both favor higher priority. Ties favor whichever was already active/queued first. Default 0. */
  priority?: number;
  /** Identifies "the same sound" for dedup. A request sharing an `id` with `maxConcurrent` others already playing *or* queued is dropped, not stacked. Omit to never dedup this cue. */
  id?: string;
  /** How many simultaneous instances sharing `id` are allowed (counting both playing and queued) before a new request is dropped as a dup. Default 1 — the same generic cue playing on top of itself rarely tells the player anything new. Raise this for a cue expected to legitimately overlap from multiple sources at once (e.g. several simultaneous impacts) while still capping it well under `maxVoices`, so it can't dominate every voice slot. No effect without `id`. */
  maxConcurrent?: number;
  /** How long, in ms, from this `play()` call until the request is too stale to actually start — checked right before the sound would play, not just at intake, so it holds whether the request played instantly, waited in queue, or briefly lost/won a voice-steal. A cue that's aged out is no longer *about* anything current by the time it would sound. Default 200. */
  queueTTL?: number;
}

interface Voice {
  sound: THREE.Audio;
  priority: number;
  id?: string;
}

interface PendingPlay {
  buffer: AudioBuffer;
  volume: number;
  priority: number;
  id?: string;
  /** When `play()` was originally called for this request — the one clock a
   *  request is ever judged against, whether it plays immediately or after
   *  queueing. */
  requestedAt: number;
  queueTTL: number;
}

/**
 * Minimal wrapper around THREE.Audio/AudioListener: the fiddly bits every
 * consumer would otherwise have to redo — attaching a listener to the
 * camera, resuming the AudioContext after the browser's autoplay policy
 * suspends it until a user gesture, and *not distorting* once a lot of cues
 * overlap — are handled here, so `play()` just works. Not a mixing graph,
 * not spatial audio, not asset management: for anything past "load a
 * buffer, play a cue," reach for the Web Audio API directly
 * (`soundSystem.listener.context` is the underlying AudioContext) or a
 * dedicated library.
 *
 * Web Audio just sums every connected source, so nothing stops a burst of
 * simultaneous plays (an AI spamming the same hit sound, several matches
 * landing in one tick) from summing past `[-1, 1]` into audible clipping —
 * a classic footgun that reads as "the audio breaks under load." `play()`
 * goes through admission control rather than straight to playback:
 *  - **Dedup.** A request sharing `id` with `maxConcurrent` (default 1)
 *    others already sounding *or* queued is dropped outright, not stacked —
 *    a cap, not always exactly one instance; raise `maxConcurrent` for a cue
 *    expected to legitimately overlap from several sources at once.
 *  - **Priority.** At `maxVoices` capacity, a new request only plays by
 *    *stealing* the lowest-priority active voice, and only if it outranks
 *    it; otherwise it queues. Draining the queue (as voices free up) also
 *    goes highest-priority-first.
 *  - **TTL, enforced at the one moment it matters.** Every request is
 *    stamped with `requestedAt` the instant `play()` is called, and
 *    `queueTTL` is checked right before a voice actually starts — not
 *    just while deciding whether to queue. A request that never has to wait
 *    plays instantly regardless (that check is ~0ms and always passes), but
 *    one that *does* wait, whether in the queue or momentarily behind a
 *    voice-steal, still gets cut off at the same age limit either way: past
 *    `queueTTL` old by the time it would actually sound, it's dropped
 *    instead — a sound effect a full second after whatever caused it just
 *    reads as broken, not merely late. The queue itself is also bounded
 *    (`maxQueueLength`, default 8), evicting the lowest-priority queued
 *    request to make room — the TTL alone only bounds how stale any *one*
 *    request can be, not how many can be queued at once, so a burst that
 *    outpaces `maxVoices` for its whole duration would otherwise keep the
 *    queue permanently full and trickle out stale-ish plays the entire time.
 *  - **Limiter.** A master `DynamicsCompressorNode` (via `listener.setFilter`)
 *    on all listener output catches the remaining case where a few voices
 *    under the cap still sum past clipping. On by default; `{ limiter: false }`
 *    opts out.
 */
export class SoundSystem {
  /** Already attached to the `camera` passed to the constructor. `listener.context`
   *  is the raw `AudioContext`, for anything past `load()`/`play()`. */
  readonly listener: THREE.AudioListener;
  private loader = new THREE.AudioLoader();
  private readonly maxVoices: number;
  private readonly maxQueueLength: number;
  private active: Voice[] = [];
  private queue: PendingPlay[] = [];

  /** Attaches the listener to `camera` immediately — nothing else needs to
   *  run before `play()` is called for the first time. */
  constructor(camera: THREE.Camera, options: SoundSystemOptions = {}) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.maxVoices = options.maxVoices ?? 12;
    this.maxQueueLength = options.maxQueueLength ?? 8;

    const resume = (): void => {
      if (this.listener.context.state === 'suspended') this.listener.context.resume();
    };
    const gestureTarget = options.gestureTarget ?? window;
    gestureTarget.addEventListener('pointerdown', resume, { once: true });
    gestureTarget.addEventListener('keydown', resume, { once: true });

    if (options.limiter ?? true) {
      const limiter = this.listener.context.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      this.listener.setFilter(limiter);
    }
  }

  /** Fetches and decodes an audio file into a reusable buffer. */
  load(url: string): Promise<AudioBuffer> {
    return this.loader.loadAsync(url);
  }

  /**
   * Requests a buffer be played as a non-positional cue. Goes through
   * dedup/priority/queueing — see the class doc — rather than always playing
   * immediately. `buffer` can come from `load()`, or from synthesizing one
   * directly via `listener.context` (e.g. an OscillatorNode rendered to a
   * buffer), so a cue can need zero external assets.
   */
  play(buffer: AudioBuffer, options: PlayOptions = {}): void {
    this.pruneQueue();

    const request: PendingPlay = {
      buffer,
      volume: options.volume ?? 1,
      priority: options.priority ?? 0,
      id: options.id,
      requestedAt: performance.now(),
      queueTTL: options.queueTTL ?? 200,
    };

    if (request.id !== undefined && this.countWithId(request.id) >= (options.maxConcurrent ?? 1)) return;

    if (this.tryPlayNow(request)) return;

    if (this.queue.length >= this.maxQueueLength) {
      const weakest = this.queue.reduce<PendingPlay | undefined>(
        (min, q) => (!min || q.priority < min.priority ? q : min),
        undefined,
      );
      if (!weakest || weakest.priority >= request.priority) return; // queue is full of equal-or-more-important requests; drop this one
      this.queue = this.queue.filter((q) => q !== weakest);
    }

    this.queue.push(request);
  }

  /** Count of currently active + queued requests sharing `id` — what
   *  `maxConcurrent` is checked against. */
  private countWithId(id: string): number {
    let count = 0;
    for (const v of this.active) if (v.id === id) count++;
    for (const q of this.queue) if (q.id === id) count++;
    return count;
  }

  /** Plays now if a voice is free, or by stealing the lowest-priority active
   *  voice when `priority` outranks it. Returns whether it started. */
  private tryPlayNow(request: PendingPlay): boolean {
    if (this.active.length >= this.maxVoices) {
      const weakest = this.active.reduce<Voice | undefined>(
        (min, v) => (!min || v.priority < min.priority ? v : min),
        undefined,
      );
      if (!weakest || weakest.priority >= request.priority) return false;
      this.stopVoice(weakest);
    }
    return this.startVoice(request);
  }

  /**
   * The one gate every request passes through right before audio actually
   * starts, whether called from `tryPlayNow` (effectively instant) or
   * `drainQueue` (however long the request waited) — so `queueTTL` is a
   * real "never actually plays this stale" guarantee, not just an intake-time
   * filter. Returns whether it started.
   */
  private startVoice(request: PendingPlay): boolean {
    if (performance.now() - request.requestedAt > request.queueTTL) return false;

    const sound = new THREE.Audio(this.listener);
    sound.setBuffer(request.buffer);
    sound.setVolume(request.volume);
    sound.play();

    const voice: Voice = { sound, priority: request.priority, id: request.id };
    this.active.push(voice);
    sound.source?.addEventListener('ended', () => this.onVoiceEnded(voice), { once: true });
    return true;
  }

  private stopVoice(voice: Voice): void {
    this.active = this.active.filter((v) => v !== voice);
    voice.sound.stop();
  }

  private onVoiceEnded(voice: Voice): void {
    this.active = this.active.filter((v) => v !== voice);
    this.drainQueue();
  }

  private pruneQueue(): void {
    const now = performance.now();
    this.queue = this.queue.filter((q) => now - q.requestedAt <= q.queueTTL);
  }

  /** Promotes queued requests into freed voice slots, highest priority first
   *  (ties keep FIFO order), dropping anything that's aged out along the way. */
  private drainQueue(): void {
    this.pruneQueue();
    this.queue.sort((a, b) => b.priority - a.priority);
    while (this.queue.length > 0 && this.active.length < this.maxVoices) {
      this.startVoice(this.queue.shift()!);
    }
  }
}
