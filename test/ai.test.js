import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../app/js/ai.js';

const IMG = 'data:image/jpeg;base64,AAAA';

test('chat request sends only the newest picture, with the vision model', () => {
  const req = A.chatRequest('sys', [
    { role: 'user', text: '', image: IMG + 'old' },
    { role: 'assistant', text: 'It is a graph.' },
    { role: 'user', text: 'And this?', image: IMG },
  ]);
  assert.equal(req.model, A.MODELS.vision);
  assert.equal(req.messages[0].role, 'system');
  assert.equal(typeof req.messages[1].content, 'string');
  assert.match(req.messages[1].content, /^\[screenshot\]/);
  assert.deepEqual(req.messages[3].content[1], { type: 'image_url', image_url: { url: IMG } });
  assert.equal(req.messages[3].content[0].text, 'And this?');
});

test('chat request without pictures uses the text model and keeps recent history', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` }));
  const req = A.chatRequest('sys', history);
  assert.equal(req.model, A.MODELS.text);
  assert.equal(req.messages.length, A.HISTORY + 1);
  assert.equal(req.messages.at(-1).content, 'm29');
});

test('system prompt keeps the student on task during focus only', () => {
  assert.match(A.chatSystem({ name: 'Mona', session: { kind: 'focus', intention: 'Essay' } }), /focus session.*Essay/s);
  assert.doesNotMatch(A.chatSystem({ session: null }), /focus session right now/);
  assert.match(A.chatSystem({ session: { kind: 'break' } }), /break/);
  assert.match(A.chatSystem({ name: 'Mona', personality: 'A cat.' }), /You are Mona.*Your character: A cat\./s);
});

test('first sentence for the pet bubble', () => {
  assert.equal(A.firstSentence('**Mitosis** is cell division. It has four phases.'), 'Mitosis is cell division.');
  assert.equal(A.firstSentence('- one\n- two'), 'one two');
  const long = A.firstSentence('word '.repeat(60), 40);
  assert.ok(long.length <= 40 && long.endsWith('…'));
});

test('plan is clamped and only adds new, valid blocks', () => {
  const raw = '```json\n' + JSON.stringify({
    intention: 'History essay',
    focusMin: 500,
    breakMin: 0,
    cycles: 3.4,
    longBreakMin: 'x',
    blockSites: ['https://www.YouTube.com/watch?v=1', 'netflix.com', 'netflix.com', 'not a site', 'docs.google.com'],
    blockApps: ['Discord', 'Spotify.exe', 'evil/path', 'tiktok.com'],
    why: 'Long blocks suit essays.',
  }) + '\n```';
  const p = A.parsePlan(raw, { blocklist: { apps: ['discord'], sites: ['youtube.com'] }, allowlist: ['docs.google.com'] });
  assert.equal(p.focusMin, 180);
  assert.equal(p.breakMin, 1);
  assert.equal(p.cycles, 3);
  assert.equal(p.longBreakMin, 0);
  assert.deepEqual(p.blockSites, ['netflix.com']);
  assert.deepEqual(p.blockApps, ['Spotify']);
  assert.equal(p.intention, 'History essay');
});

test('plan errors are readable', () => {
  assert.throws(() => A.parsePlan('not json'), /garbled/);
  assert.throws(() => A.parsePlan('{"hello":1}'), /wasn't a plan/);
});

test('planner request lists what is already blocked', () => {
  const req = A.planRequest('maths revision for 2 hours', { blocklist: { apps: ['Steam'], sites: ['reddit.com'] }, date: new Date(2026, 0, 1, 9, 5) });
  assert.equal(req.json, true);
  assert.match(req.messages[1].content, /09:05/);
  assert.match(req.messages[1].content, /reddit\.com, Steam/);
});
