// App clock. Normally real time; the test bench can run it faster so a
// 50-minute session can be checked in a minute. Speed persists across reloads.

const KEY = 'togami.clock';

let baseReal = Date.now();
let baseApp = baseReal;
let speed = 1;

try {
  const c = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (c && c.speed > 1) {
    ({ baseReal, baseApp, speed } = c);
  }
} catch {
  // real time
}

export function now() {
  return baseApp + (Date.now() - baseReal) * speed;
}

export function getSpeed() {
  return speed;
}

export function setSpeed(next) {
  const t = now();
  baseReal = Date.now();
  baseApp = t;
  speed = next;
  persist();
}

/** Jump the app clock forward (test bench). */
export function skip(ms) {
  const t = now();
  baseReal = Date.now();
  baseApp = t + ms;
  persist();
}

export function reset() {
  baseReal = Date.now();
  baseApp = baseReal;
  speed = 1;
  persist();
}

function persist() {
  try {
    if (speed === 1 && baseApp === baseReal) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ baseReal, baseApp, speed }));
  } catch {
    // ignore
  }
}
