// Copy for the two voices. "heir" is the cold, superior one.

import { fmtMin } from './format.js';

const neutral = {
  idlePrompt: 'What are you working on?',
  idlePlaceholder: 'e.g. History essay, intro and first section',
  start: 'Start session',
  blockTitle: (t) => `${t} is blocked`,
  blockBody: (left, intention) => (intention ? `You're working on “${intention}”. ${left} left in this block.` : `${left} left in this block.`),
  blockLockout: (left) => `You quit your last session, so blocks stay on for ${left}.`,
  backToWork: 'Back to work',
  pausePending: 'Blocking pauses in',
  paused: 'Paused. Blocking is off.',
  quitHold: 'Hold to quit',
  quitHoldHint: 'Keep holding for 5 seconds.',
  quitType: 'Type this to continue:',
  quitWait: 'Take a minute. If the urge passes, go back to work.',
  quitConfirm: 'Quit session',
  neverMind: 'Never mind, keep working',
  lockoutTitle: 'Blocks are locked',
  lockoutBody: (left) => `You quit your last session. Blocks stay on for ${left}.`,
  complete: 'Session complete',
  completeAsk: (intention) => (intention ? `Did you finish “${intention}”?` : 'Did you finish what you planned?'),
  pardonEarned: 'You earned a pardon. It cancels the penalty for one quit.',
  emptyLedger: 'No sessions yet. Finished and quit sessions will be listed here.',
  closedQuit: 'Togami was closed during your session, so it counted as a quit.',
};

const heir = {
  ...neutral,
  idlePrompt: 'What are you working on? Be specific.',
  blockTitle: (t) => `${t}. Predictable.`,
  blockBody: (left, intention) => (intention ? `You have ${left} left on “${intention}”. Spend them on it.` : `You have ${left} left. Spend them on work.`),
  blockLockout: (left) => `You quit. You don't get ${left} of distraction as a reward.`,
  backToWork: 'Fine, back to work',
  quitHold: 'Hold, if you insist',
  quitHoldHint: 'Five seconds. Commitment is apparently hard.',
  quitWait: 'Sixty seconds. Most people come to their senses.',
  neverMind: 'I came to my senses',
  lockoutTitle: 'You quit',
  lockoutBody: (left) => `Your apps stay locked for ${left}. The ledger has been updated.`,
  complete: 'Adequate. Session complete.',
  completeAsk: (intention) => (intention ? `And “${intention}”? Done, or not?` : 'Did you actually finish?'),
  pardonEarned: 'A pardon. Earned, for once. It cancels one quit.',
  emptyLedger: 'Nothing to judge yet.',
  closedQuit: 'Closing Togami does not end the session. It counted as a quit.',
};

export const QUIT_PHRASE = "I'm choosing to stop working";

export function voice(state) {
  return state.settings.voice === 'heir' ? heir : neutral;
}

export { fmtMin };
