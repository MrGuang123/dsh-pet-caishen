export function activityKey(row) {
  if (!row?.sessionId) return '';
  return `${row.sessionId}:${row.notificationId || row.completion?.id || `${row.sourceId || ''}:${row.status}`}`;
}
export function canNotify(mode, status) {
  return mode !== 'quiet' && (mode === 'all' || ['waiting', 'blocked'].includes(status));
}
export function fixedTarget(row) {
  return row?.sessionId ? { sessionId: row.sessionId, ...(row.status === 'ready' && !row.completion?.acknowledged && row.completion?.id ? { completionId: row.completion.id } : {}) } : null;
}
export function taskDetail(row, now = Date.now()) {
  if (!row) return '';
  let text = row.detail || '';
  if (row.status === 'running' && Number.isFinite(row.turn?.startedAt)) {
    const elapsed = Math.max(0, Math.floor(((row.turn.endedAt ?? now) - row.turn.startedAt) / 1000));
    text += ` · ${Math.floor(elapsed / 60)}分${String(elapsed % 60).padStart(2, '0')}秒`;
  }
  return text;
}
export function taskCounts(rows = []) {
  const counts = { waiting: 0, blocked: 0, ready: 0, running: 0 };
  const ids = new Set();
  for (const row of rows) if (!ids.has(row.sessionId)) { ids.add(row.sessionId); if (row.status in counts) counts[row.status]++; }
  return counts;
}
