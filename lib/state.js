import { DEFAULT_STORED_PREFERENCES, normalizeStoredPreferences, validateStoredPreferencePatch, toLegacyPreferences } from './preference-schema.js';
export { DEFAULT_PREFERENCES, validatePreferences } from './preference-schema.js';
const PRIORITY = { waiting: 5, blocked: 4, ready: 3, running: 2, idle: 1 };
export const STATUSES = Object.freeze(Object.keys(PRIORITY));
const DETAILS = { idle: '掌柜忙，我在这儿陪着。', running: '算盘拨起来了。', waiting: '掌柜，这里等你拿主意。', ready: '本轮工作结束，掌柜请过目。', blocked: '这步没跑通，回去看看。', offline: '还没连上 DSH，阿财先候着。' };
export const FORTUNES = Object.freeze([
  '宜小步提交，忌一把梭哈。', '今日宜先看报错，再拨算盘。', '需求说清楚，元宝自然来。', '写完伸个懒腰，好运不靠熬夜。', '宜补关键测试，财路更稳。', '先把一件事做好，再开下一单。',
  '先喝口水，再解一个结。', '宜拆小任务，忌一口吃成大元宝。', '掌柜从容一点，阿财也不赶路。', '今天的好运，藏在一次认真检查里。', '宜留点余地，也留点休息时间。', '代码慢慢磨，日子好好过。',
  '有疑问先确认，少走一段弯路。', '宜先复现，再动手。', '收工也算今日进展。', '小小一步，也值得作个揖。'
]);
const shortString = (v, max = 180) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const copy = v => structuredClone(v);
const projectPreferences = p => ({ ...p, quiet: toLegacyPreferences(p).quiet });
export function createStateStore({ mode = 'dsh', now = Date.now, preferences = DEFAULT_STORED_PREFERENCES } = {}) {
  const rows = new Map();
  const presented = new Set();
  const orders = new Map();
  let sequence = 0;
  const projectRow = row => ({ ...row, notificationPresented: row.notificationId ? presented.has(row.notificationId) : false });
  let connected = mode === 'demo', lastSeen = connected ? now() : null;
  let prefs = normalizeStoredPreferences(preferences), fortuneIndex = 0, lastSessionId = null;
  return {
    setLastSessionId(value) {
      if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('无效会话标识');
      lastSessionId = value;
    },
    getLastSessionId: () => lastSessionId,
    setConnected(value) { connected = value === true; lastSeen = connected ? now() : lastSeen; },
    upsertSession(row) {
      const sessionId = shortString(row?.sessionId, 160);
      if (!sessionId || !STATUSES.includes(row?.status)) throw new TypeError('无效会话状态');
      const previous = rows.get(sessionId), updatedAt = Number.isFinite(row.updatedAt) ? row.updatedAt : now();
      if (row.sourceId && previous?.sourceId === row.sourceId && row.revision < previous.revision) return;
      if (!row.sourceId && previous && previous.updatedAt > updatedAt) return;
      orders.set(sessionId, ++sequence);
      rows.set(sessionId, {
        sessionId, title: shortString(row.title) || 'DSH 会话', status: row.status,
        detail: shortString(row.detail) || DETAILS[row.status], updatedAt,
        sourceId: shortString(row.sourceId, 160) || null, revision: Number.isSafeInteger(row.revision) ? row.revision : 0,
        turn: row.turn ? { id: row.turn.id, startedAt: row.turn.startedAt, endedAt: row.turn.endedAt, endReason: row.turn.endReason } : null,
        completion: row.completion ? { id: row.completion.id, acknowledged: row.completion.acknowledged === true } : null,
        waiting: { approval: row.waiting?.approval === true, question: row.waiting?.question === true, unknown: row.waiting?.unknown === true },
        notificationId: shortString(row.notificationId, 160) || null
      });
      if (rows.size > 300) { const old = [...rows.values()].filter(r => r.status === 'idle').sort((a,b) => orders.get(a.sessionId)-orders.get(b.sessionId))[0]; if (old) { rows.delete(old.sessionId); orders.delete(old.sessionId); } }
      lastSeen = now();
    },
    removeSession(id) { rows.delete(id); orders.delete(id); },
    acknowledge(id, completionId) {
      const row = rows.get(id);
      if (!completionId || !row?.completion || row.completion.id !== completionId || row.completion.acknowledged) return false;
      row.completion.acknowledged = true;
      if (row.status === 'ready') { row.status = 'idle'; row.detail = DETAILS.idle; }
      return true;
    },
    presentReminder(id, notificationId) {
      const row = rows.get(id);
      if (!notificationId || row?.notificationId !== notificationId) return false;
      presented.add(notificationId);
      if (presented.size > 1000) presented.delete(presented.values().next().value);
      return true;
    },
    getSession(id) { const row = rows.get(id); return row ? copy(projectRow(row)) : null; },
    setPreferences(value) { const { schemaVersion, ...patch } = value; if (schemaVersion !== undefined && schemaVersion !== 2) throw new TypeError('不支持的偏好版本'); prefs = validateStoredPreferencePatch(patch, prefs); return projectPreferences(prefs); },
    getStoredPreferences: () => ({ ...prefs }),
    nextFortune() { fortuneIndex = (fortuneIndex + 1 + Math.floor(Math.random() * (FORTUNES.length - 1))) % FORTUNES.length; return FORTUNES[fortuneIndex]; },
    getSnapshot() {
      const sessions = [...rows.values()].map(projectRow).sort((a,b) => PRIORITY[b.status]-PRIORITY[a.status] || orders.get(b.sessionId)-orders.get(a.sessionId));
      const activity = connected ? sessions[0] ?? { status: 'idle', sessionId: null, title: '阿财已就位', detail: DETAILS.idle, updatedAt: lastSeen ?? now() }
        : { status: 'offline', sessionId: null, title: '等待 DSH', detail: DETAILS.offline, updatedAt: lastSeen ?? 0 };
      return copy({ version: 2, connection: { connected, lastSeen, mode }, activity, navigation: { lastSessionId }, sessions: connected ? sessions : [], preferences: projectPreferences(prefs), fortune: { text: FORTUNES[fortuneIndex] } });
    }
  };
}
