import { randomUUID } from 'node:crypto';

export const END_REASONS = Object.freeze(['completed', 'error', 'blocked', 'max-tokens', 'aborted', 'interrupted']);
export function waitingFacts({ approval = false, questionObserver = false, questionProjection = false, clientPending = false } = {}) {
  return { approval: approval === true, question: questionObserver === true || questionProjection === true, unknown: clientPending === true };
}
/** One in-memory tracker per live root instance. No title/body/arguments enter it. */
export function createActivityFacts({ now = Date.now, id = randomUUID } = {}) {
  const sourceId = id();
  let turn = null, completion = null, revision = 0, errorId = null;
  const snapshot = () => ({ sourceId, revision, turn: turn && { ...turn }, completion: completion && { ...completion }, errorId });
  function begin(known) {
    turn = { id: id(), startedAt: known ? now() : null, endedAt: null, endReason: null };
    completion = null; errorId = null; revision++;
    return snapshot();
  }
  return {
    snapshot,
    observeRunning() { if (!turn) begin(false); return snapshot(); },
    start() { return begin(true); },
    end(reason) {
      if (!turn) begin(false);
      if (turn.endedAt !== null) return snapshot();
      turn.endedAt = now();
      turn.endReason = END_REASONS.includes(reason) ? reason : 'unknown';
      if (reason === 'completed') completion = { id: id(), acknowledged: false };
      if (['error', 'blocked', 'max-tokens'].includes(reason)) errorId = id();
      revision++;
      return snapshot();
    },
    error() { if (!errorId) { errorId = id(); revision++; } return snapshot(); },
    acknowledge(expectedId) {
      if (!expectedId || !completion || completion.id !== expectedId || completion.acknowledged) return false;
      completion.acknowledged = true; revision++; return true;
    }
  };
}
