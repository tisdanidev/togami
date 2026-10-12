// Short jingles for session moments, synthesised with Web Audio (soft bell
// tones, no audio files). One jingle per transition, never stacked.

let ctx = null;
let lastPlayed = -Infinity;

function audio() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Call from any click or key press so later jingles are allowed to play. */
export function unlock() {
  audio();
}

const NOTE = { G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.0, C6: 1046.5, E6: 1318.5 };

/** One bell strike: a sine with two quieter overtones and a long soft decay. */
function bell(ac, out, freq, at, { length = 1.4, level = 1, bright = 1 } = {}) {
  const partials = [
    [1, 1],
    [2, 0.28 * bright],
    [3, 0.08 * bright],
  ];
  for (const [mult, gain] of partials) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    const peak = 0.22 * level * gain;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length / mult);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }
}

// [note, start (s), options]
const JINGLES = {
  // focus begins: rising, bright
  workStart: [
    ['G4', 0, { length: 0.9 }],
    ['C5', 0.13, { length: 0.9 }],
    ['E5', 0.26, { length: 1.5, level: 1.05 }],
  ],
  // break begins: falling, warm and slow
  breakStart: [
    ['E5', 0, { length: 1.4, bright: 0.6 }],
    ['C5', 0.24, { length: 1.4, bright: 0.6 }],
    ['G4', 0.48, { length: 2.0, bright: 0.5 }],
  ],
  // break over: a brisk call back to work
  breakEnd: [
    ['D5', 0, { length: 0.7 }],
    ['G5', 0.11, { length: 0.7 }],
    ['D5', 0.32, { length: 0.6, level: 0.8 }],
    ['G5', 0.43, { length: 1.4, level: 1.05 }],
  ],
  // whole session done: arpeggio into a held chord
  sessionEnd: [
    ['C5', 0, { length: 0.8 }],
    ['E5', 0.11, { length: 0.8 }],
    ['G5', 0.22, { length: 0.8 }],
    ['C6', 0.33, { length: 2.2, level: 0.9 }],
    ['E5', 0.33, { length: 2.2, level: 0.55 }],
    ['G5', 0.33, { length: 2.2, level: 0.55 }],
  ],
};

export const SOUNDS = Object.keys(JINGLES);

export function play(name, volume = 0.8) {
  const notes = JINGLES[name];
  const ac = notes && audio();
  if (!ac) return;
  // a jingle is still ringing: don't stack another on top
  if (performance.now() - lastPlayed < 900) return;
  lastPlayed = performance.now();
  const out = ac.createGain();
  out.gain.value = volume;
  const tone = ac.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 5200;
  out.connect(tone).connect(ac.destination);
  const t0 = ac.currentTime + 0.03;
  for (const [n, at, opts] of notes) bell(ac, out, NOTE[n], t0 + at, opts);
}
