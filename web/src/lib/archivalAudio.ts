// Zero-dependency procedural Web Audio API synthesizer for Playfair Archival Ledger.
// Generates subtle tactile parchment rustles, brass instrument clicks, and ink seal thuds.

const STORAGE_KEY = "playfair-archival-audio-muted";

let sharedCtx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Ignore subscriber errors
    }
  });
}

export function isAudioMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setAudioMuted(muted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, muted ? "true" : "false");
  } catch {
    // Ignore storage quota / privacy mode restrictions
  }
  notifyListeners();
}

export function toggleAudioMuted(): boolean {
  const next = !isAudioMuted();
  setAudioMuted(next);
  if (!next) {
    playBrassTick();
  }
  return next;
}

export function subscribeAudioMute(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") {
    return () => {
      listeners.delete(listener);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (isAudioMuted()) return null;

  const AudioCtx =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;

  try {
    if (!sharedCtx) {
      sharedCtx = new AudioCtx();
    }
    if (sharedCtx.state === "suspended") {
      void sharedCtx.resume().catch(() => {
        // Browsers may block before user gesture; ignore gracefully
      });
    }
    return sharedCtx;
  } catch {
    return null;
  }
}

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) {
    return noiseBuffer;
  }
  const length = Math.floor(ctx.sampleRate * 0.45);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Slightly pink-weighted noise for warm paper texture
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + white * 0.029;
    b1 = 0.985 * b1 + white * 0.032;
    b2 = 0.95 * b2 + white * 0.048;
    data[i] = (b0 + b1 + b2 + white * 0.18) * 1.4;
  }
  noiseBuffer = buffer;
  return buffer;
}

/** Soft parchment folio page-turn sound on route/view transitions. */
export function playPaperTurn(): void {
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== "running") return;

  try {
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = getNoiseBuffer(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.setValueAtTime(1.4, now);
    filter.frequency.setValueAtTime(850, now);
    filter.frequency.exponentialRampToValueAtTime(2200, now + 0.055);
    filter.frequency.exponentialRampToValueAtTime(1050, now + 0.14);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.045, now + 0.022);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.145);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    source.start(now);
    source.stop(now + 0.16);
  } catch {
    // Ignore audio scheduling errors
  }
}

/** Crisp mechanical brass detent click for tabs, timeframe pills, and sector switches. */
export function playBrassTick(): void {
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== "running") return;

  try {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(1920, now);
    osc.frequency.exponentialRampToValueAtTime(580, now + 0.028);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.032, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.036);

    // Subtle high harmonic tick
    const ping = ctx.createOscillator();
    ping.type = "sine";
    ping.frequency.setValueAtTime(3400, now);
    ping.frequency.exponentialRampToValueAtTime(2100, now + 0.015);

    const pingGain = ctx.createGain();
    pingGain.gain.setValueAtTime(0.014, now);
    pingGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.018);

    ping.connect(pingGain);
    pingGain.connect(ctx.destination);

    ping.start(now);
    ping.stop(now + 0.02);
  } catch {
    // Ignore audio scheduling errors
  }
}

/** Resonant archival ink-seal / stamp thud for InfoSeals, portals, and copy briefs. */
export function playInkStamp(): void {
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== "running") return;

  try {
    const now = ctx.currentTime;

    // Low warm stamp thump
    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(148, now);
    thump.frequency.exponentialRampToValueAtTime(48, now + 0.095);

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.linearRampToValueAtTime(0.065, now + 0.006);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

    thump.connect(thumpGain);
    thumpGain.connect(ctx.destination);
    thump.start(now);
    thump.stop(now + 0.12);

    // Parchment blot texture
    const blot = ctx.createBufferSource();
    blot.buffer = getNoiseBuffer(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(680, now);

    const blotGain = ctx.createGain();
    blotGain.gain.setValueAtTime(0.0001, now);
    blotGain.gain.linearRampToValueAtTime(0.022, now + 0.008);
    blotGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.065);

    blot.connect(filter);
    filter.connect(blotGain);
    blotGain.connect(ctx.destination);
    blot.start(now);
    blot.stop(now + 0.075);
  } catch {
    // Ignore audio scheduling errors
  }
}
