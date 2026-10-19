const PRIORITY = { waiting: 5, blocked: 4, ready: 3, running: 2, idle: 1 };
export const STATUSES = Object.freeze(Object.keys(PRIORITY));
export const DEFAULT_PREFERENCES = Object.freeze({ size: 160, quiet: false, reducedMotion: false, hidden: false });
const DETAILS = {
  idle: "掌柜忙，我在这儿陪着。", running: "算盘拨起来了。", waiting: "掌柜，这里等你拿主意。",
  ready: "本轮工作结束，掌柜请过目。", blocked: "这步没跑通，回去看看。", offline: "还没连上 DSH，阿财先候着。"
};
export const FORTUNES = Object.freeze([
  "宜小步提交，忌一把梭哈。", "今日宜先看报错，再拨算盘。", "需求说清楚，元宝自然来。",
  "写完伸个懒腰，好运不靠熬夜。", "宜补关键测试，财路更稳。", "先把一件事做好，再开下一单。"
]);

function shortString(value, max = 180) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

export function validatePreferences(value, previous = DEFAULT_PREFERENCES) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("偏好必须是对象");
  const keys = new Set(["size", "quiet", "reducedMotion", "hidden"]);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new TypeError("不支持的偏好字段");
  const next = { ...previous };
  if ("size" in value) {
    if (!Number.isFinite(value.size) || value.size < 120 || value.size > 240) throw new RangeError("尺寸范围为 120–240");
    next.size = Math.round(value.size);
  }
  for (const key of ["quiet", "reducedMotion", "hidden"]) {
    if (key in value) {
      if (typeof value[key] !== "boolean") throw new TypeError(`${key} 必须为布尔值`);
      next[key] = value[key];
    }
  }
  return next;
}

/** Business state is supplied by DSH facts; rendering-only sleeping/pet never enter this store. */
export function createStateStore({ mode = "dsh", now = Date.now, preferences = DEFAULT_PREFERENCES } = {}) {
  const rows = new Map();
  let connected = mode === "demo";
  let lastSeen = connected ? now() : null;
  let prefs = validatePreferences(preferences);
  let fortune = FORTUNES[0];
  let lastSessionId = null;
  return {
    setLastSessionId(value) {
      if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("无效会话标识");
      lastSessionId = value;
    },
    getLastSessionId() { return lastSessionId; },
    setConnected(value) { connected = value === true; lastSeen = connected ? now() : lastSeen; },
    upsertSession(row) {
      const sessionId = shortString(row?.sessionId, 160);
      if (!sessionId || !STATUSES.includes(row?.status)) throw new TypeError("无效会话状态");
      const previous = rows.get(sessionId);
      const updatedAt = Number.isFinite(row.updatedAt) ? row.updatedAt : now();
      if (previous && previous.updatedAt > updatedAt) return;
      rows.set(sessionId, {
        sessionId, title: shortString(row.title) || "DSH 会话", status: row.status,
        detail: shortString(row.detail) || DETAILS[row.status], updatedAt
      });
      // The companion tracks current activity, not a permanent conversation history.
      if (rows.size > 300) {
        const old = [...rows.values()].filter(r => r.status === "idle").sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (old) rows.delete(old.sessionId);
      }
      lastSeen = now();
    },
    removeSession(id) { rows.delete(id); },
    acknowledge(id) {
      const row = rows.get(id);
      if (row?.status === "ready") rows.set(id, { ...row, status: "idle", detail: DETAILS.idle, updatedAt: now() });
    },
    getSession(id) { const row = rows.get(id); return row ? { ...row } : null; },
    setPreferences(value) { prefs = validatePreferences(value, prefs); return { ...prefs }; },
    nextFortune() {
      const index = FORTUNES.indexOf(fortune);
      fortune = FORTUNES[(index + 1) % FORTUNES.length];
      return fortune;
    },
    getSnapshot() {
      const sessions = [...rows.values()].sort((a, b) => PRIORITY[b.status] - PRIORITY[a.status] || b.updatedAt - a.updatedAt);
      const activity = connected
        ? sessions[0] ?? { status: "idle", sessionId: null, title: "阿财已就位", detail: DETAILS.idle, updatedAt: lastSeen ?? now() }
        : { status: "offline", sessionId: null, title: "等待 DSH", detail: DETAILS.offline, updatedAt: lastSeen ?? 0 };
      return {
        version: 1, connection: { connected, lastSeen, mode }, activity: { ...activity },
        navigation: { lastSessionId },
        sessions: connected ? sessions.map(row => ({ ...row })) : [], preferences: { ...prefs }, fortune: { text: fortune }
      };
    }
  };
}
