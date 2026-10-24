/** Compatibility helpers for legacy four-field callers. */
export const DEFAULT_PREFERENCES = Object.freeze({ size: 160, quiet: false, reducedMotion: false, hidden: false });

// Keep legacy validation stable. The active HTTP/store contract uses the
// versioned normalizer and patch validator below.
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

/** Versioned storage; legacy quiet is accepted only as an input alias. */
export const PREFERENCE_SCHEMA_VERSION = 2;
export const NOTIFICATION_MODES = Object.freeze(["all", "attention", "quiet"]);
export const DEFAULT_STORED_PREFERENCES = Object.freeze({
  schemaVersion: PREFERENCE_SCHEMA_VERSION,
  size: DEFAULT_PREFERENCES.size,
  notificationMode: "all",
  snoozedUntil: null,
  reducedMotion: DEFAULT_PREFERENCES.reducedMotion,
  hidden: DEFAULT_PREFERENCES.hidden,
  mini: false, largeText: false, positionLocked: false, dockEdge: false, shortcutKey: "A", onboardingSeen: false
});

const storedKeys = new Set(["schemaVersion", "size", "quiet", "notificationMode", "snoozedUntil", "reducedMotion", "hidden", "mini", "largeText", "positionLocked", "dockEdge", "shortcutKey", "onboardingSeen"]);
const patchKeys = new Set([...storedKeys].filter(key => key !== "schemaVersion"));
const has = (value, key) => Object.hasOwn(value, key);

function assertRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("偏好必须是普通对象");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.has(key)) throw new TypeError("不支持的偏好字段");
  }
}

function extraFields(value, partial = false) {
  const next = {};
  for (const key of ['mini', 'largeText', 'positionLocked', 'dockEdge', 'onboardingSeen']) {
    if (!has(value, key) && partial) continue;
    if (has(value, key) && typeof value[key] !== 'boolean') throw new TypeError('偏好必须为布尔值');
    next[key] = has(value, key) ? value[key] : false;
  }
  if (has(value, 'shortcutKey') || !partial) {
    const key = has(value, 'shortcutKey') ? value.shortcutKey : 'A';
    if (key !== null && (typeof key !== 'string' || !/^[A-Z]$/.test(key))) throw new TypeError('快捷键仅支持大写字母或 null');
    next.shortcutKey = key;
  }
  return next;
}

function validateTimestamp(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("暂静到期时间必须为非负安全整数或 null");
  return value;
}

function validateMode(value) {
  if (!NOTIFICATION_MODES.includes(value)) throw new TypeError("无效提醒模式");
  return value;
}

function validateCompatibleFields(value) {
  const compatible = {};
  for (const key of ["size", "quiet", "reducedMotion", "hidden"]) {
    if (has(value, key)) compatible[key] = value[key];
  }
  return validatePreferences(compatible);
}

/**
 * Normalize unversioned legacy or schema v2 storage into a fresh canonical object.
 * A valid explicit notificationMode wins over quiet; quiet never enters storage.
 * Unknown keys/versions and invalid values are rejected instead of copied through.
 */
export function normalizeStoredPreferences(value = {}) {
  assertRecord(value, storedKeys);
  if (has(value, "schemaVersion") && value.schemaVersion !== PREFERENCE_SCHEMA_VERSION) throw new TypeError("不支持的偏好版本");
  const compatible = validateCompatibleFields(value);
  return {
    schemaVersion: PREFERENCE_SCHEMA_VERSION,
    size: compatible.size,
    notificationMode: has(value, "notificationMode")
      ? validateMode(value.notificationMode) : compatible.quiet ? "quiet" : "all",
    snoozedUntil: has(value, "snoozedUntil") ? validateTimestamp(value.snoozedUntil) : null,
    reducedMotion: compatible.reducedMotion,
    hidden: compatible.hidden,
    ...extraFields(value)
  };
}

export const migrateStoredPreferences = normalizeStoredPreferences;

/**
 * Apply a whitelisted partial update without mutating either input. An explicit
 * legacy quiet patch selects quiet/all unless the same patch provides a mode.
 * Changing mode keeps the existing snooze; pass snoozedUntil:null to end it.
 */
export function validateStoredPreferencePatch(value, previous = DEFAULT_STORED_PREFERENCES) {
  assertRecord(value, patchKeys);
  const next = normalizeStoredPreferences(previous);
  const compatible = validateCompatibleFields(value);
  for (const key of ["size", "reducedMotion", "hidden"]) {
    if (has(value, key)) next[key] = compatible[key];
  }
  if (has(value, "notificationMode")) next.notificationMode = validateMode(value.notificationMode);
  else if (has(value, "quiet")) next.notificationMode = compatible.quiet ? "quiet" : "all";
  if (has(value, "snoozedUntil")) next.snoozedUntil = validateTimestamp(value.snoozedUntil);
  Object.assign(next, extraFields(value, true));
  return next;
}

/** Project the selected mode to legacy preferences; temporary snooze is separate. */
export function toLegacyPreferences(value) {
  const normalized = normalizeStoredPreferences(value);
  return {
    size: normalized.size,
    quiet: normalized.notificationMode === "quiet",
    reducedMotion: normalized.reducedMotion,
    hidden: normalized.hidden
  };
}

/**
 * Resolve at an explicitly supplied epoch-millisecond clock value. Deadlines are
 * absolute: restarting does not reset them; moving the clock forward can expire
 * snooze and moving it backward can increase its remaining duration. This pure
 * function neither clears the stored deadline nor rewrites the selected mode.
 */
export function resolveNotificationPolicy(value, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError("当前时间必须为非负安全整数");
  const normalized = normalizeStoredPreferences(value);
  const snoozed = normalized.snoozedUntil !== null && normalized.snoozedUntil > nowMs;
  return {
    notificationMode: normalized.notificationMode,
    effectiveMode: snoozed ? "quiet" : normalized.notificationMode,
    snoozed,
    remainingMs: snoozed ? normalized.snoozedUntil - nowMs : 0
  };
}
