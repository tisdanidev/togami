// AI help, the pure part: prompts, the messages sent to Groq, and reading the
// session planner's answer. The request itself goes through platform.js (the
// desktop app sends it from native code, where the key is kept). Unit-tested.

import { LIMITS, ALWAYS_ALLOWED, clampField } from './engine.js';

/** Groq models. Change these if Groq retires one (console.groq.com/docs/models). */
export const MODELS = {
  text: 'llama-3.3-70b-versatile',
  vision: 'meta-llama/llama-4-scout-17b-16e-instruct',
};

/** How many earlier chat messages go with each question. */
export const HISTORY = 12;

const STYLE =
  'Keep answers short and clear: a few sentences, or a short list when steps help. Plain text: no headings, tables or LaTeX ' +
  '(write maths like x^2 + 3x = 10). You may use **bold** for a key word. When you are shown a screenshot, say briefly what it ' +
  'is, then explain the important part simply, like a good tutor. With homework, help the student understand and get there ' +
  'themselves rather than only giving the final answer.';

/**
 * The system prompt for the chat. `ctx` = { name, personality, session }, where
 * session is null or { kind: 'focus' | 'break' | 'long', intention }.
 */
export function chatSystem({ name = 'Togami', personality = '', session = null } = {}) {
  const parts = [`You are ${name}, the study companion inside Togami, a focus timer and distraction blocker for students.`];
  const p = String(personality || '').trim().slice(0, 800);
  if (p) parts.push(`Your character: ${p} Stay in character, but being useful comes first.`);
  parts.push(STYLE);
  if (session?.kind === 'focus') {
    parts.push(
      `The student is in a focus session right now${session.intention ? `, working on: ${session.intention}` : ''}. ` +
        'Help with their work. If they want to chat about something unrelated, say so kindly in one sentence and point them back ' +
        'to the work; they can chat freely on a break.',
    );
  } else if (session) {
    parts.push('The student is on a break between focus blocks, so casual chat is fine. Keep it light.');
  }
  return parts.join('\n\n');
}

/**
 * The chat request. `history` is [{ role: 'user' | 'assistant', text, image? }],
 * oldest first, ending with the new question. Only the newest picture is sent
 * (older ones become a note), and the vision model is used when there is one.
 */
export function chatRequest(system, history) {
  const recent = history.filter((m) => m.text || m.image).slice(-HISTORY);
  const newest = recent.findLastIndex((m) => m.image);
  const messages = [{ role: 'system', content: system }];
  recent.forEach((m, i) => {
    const text = m.text || (m.image ? 'Explain what is in this part of my screen.' : '');
    if (m.role === 'user' && m.image && i === newest) {
      messages.push({ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: m.image } }] });
    } else {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.image ? `[screenshot] ${text}` : text });
    }
  });
  return { model: newest >= 0 ? MODELS.vision : MODELS.text, messages, json: false };
}

/** The first sentence of a reply, short enough for the pet's speech box. */
export function firstSentence(text, max = 140) {
  const plain = String(text || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = plain.match(/^.+?[.!?](?=\s|$)/);
  const s = m ? m[0] : plain;
  return s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

// ---------- session planner ----------

const PLAN_SYSTEM =
  'You plan one focus session for a student who uses Togami, a focus timer that blocks distracting apps and sites. ' +
  'Reply with a JSON object only, with these keys: ' +
  '"intention": what they will work on, as a short task name (at most 60 characters); ' +
  `"focusMin": minutes per focus block (${LIMITS.focusMin[0]}-${LIMITS.focusMin[1]}); ` +
  `"breakMin": minutes per short break (${LIMITS.breakMin[0]}-${LIMITS.breakMin[1]}); ` +
  `"cycles": number of focus blocks (${LIMITS.cycles[0]}-${LIMITS.cycles[1]}); ` +
  `"longBreakMin": a longer break at the end of the session, 0 for none (${LIMITS.longBreakMin[0]}-${LIMITS.longBreakMin[1]}); ` +
  '"blockSites": up to 5 website domains (like "youtube.com") that would distract from this task and are not already blocked; ' +
  '"blockApps": up to 5 app names (like "Discord") that would distract and are not already blocked; ' +
  '"why": one or two sentences on why this plan fits. ' +
  'Fit the total time to what they describe and the time of day. Use about 25 minute blocks for light or tiring work and ' +
  '45-50 minute blocks for essays and deep work. Never suggest blocking something they need for the task.';

/** The planner request. `ctx` = { blocklist: { apps, sites }, allowlist, date }. */
export function planRequest(text, { blocklist = { apps: [], sites: [] }, allowlist = [], date = new Date() } = {}) {
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const user = [
    `What I need to do: ${String(text).trim().slice(0, 1000)}`,
    `It is ${hm} now.`,
    `Already blocked: ${[...blocklist.sites, ...blocklist.apps].join(', ') || 'nothing'}.`,
    allowlist.length ? `Never block: ${allowlist.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { model: MODELS.text, messages: [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: user }], json: true };
}

/** A site the way the blocklist stores it (example.com), or null. */
export function cleanSite(s) {
  const v = String(s || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) && v.length <= 80 ? v : null;
}

/**
 * Reads the planner's answer into { intention, focusMin, breakMin, cycles,
 * longBreakMin, blockSites, blockApps, why }, every number within Togami's
 * limits and only blocks that aren't listed or allowed already. Throws if it
 * isn't a plan.
 */
export function parsePlan(raw, { blocklist = { apps: [], sites: [] }, allowlist = [] } = {}) {
  let p;
  try {
    p = JSON.parse(String(raw).replace(/^\s*```(?:json)?|```\s*$/g, ''));
  } catch {
    throw new Error("The plan came back garbled. Try again.");
  }
  if (!p || typeof p !== 'object' || p.focusMin == null) throw new Error("That answer wasn't a plan. Try saying more about the task.");
  const num = (f, fallback) => clampField(f, Math.round(Number(p[f])), fallback);
  const taken = new Set([...ALWAYS_ALLOWED, ...allowlist, ...blocklist.apps, ...blocklist.sites].map((x) => String(x).toLowerCase()));
  const fresh = (list, clean) => {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      const v = clean(x);
      if (v && !taken.has(v.toLowerCase()) && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
    }
    return out.slice(0, 5);
  };
  const cleanApp = (x) => {
    const v = String(x || '').replace(/\.exe$/i, '').trim();
    return v && v.length <= 40 && !/[\\/<>]/.test(v) && !/\.[a-z]{2,}$/i.test(v) ? v : null;
  };
  return {
    intention: String(p.intention || '').trim().slice(0, 120),
    focusMin: num('focusMin', 25),
    breakMin: num('breakMin', 5),
    cycles: num('cycles', 4),
    longBreakMin: num('longBreakMin', 0),
    blockSites: fresh(p.blockSites, cleanSite),
    blockApps: fresh(p.blockApps, cleanApp),
    why: String(p.why || '').trim().slice(0, 400),
  };
}
