import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PREFERENCES, validatePreferences, PREFERENCE_SCHEMA_VERSION,
  NOTIFICATION_MODES, DEFAULT_STORED_PREFERENCES, normalizeStoredPreferences,
  migrateStoredPreferences, validateStoredPreferencePatch, toLegacyPreferences,
  resolveNotificationPolicy
} from "../lib/preference-schema.js";

test("the existing preference contract remains four fields with its defaults and rounding", () => {
  assert.deepEqual(DEFAULT_PREFERENCES, { size: 160, quiet: false, reducedMotion: false, hidden: false });
  assert.equal(Object.isFrozen(DEFAULT_PREFERENCES), true);
  assert.deepEqual(validatePreferences({}), DEFAULT_PREFERENCES);
  const previous = { size: 200, quiet: true, reducedMotion: true, hidden: true };
  assert.deepEqual(validatePreferences({ size: 120.6, hidden: false }, previous), {
    size: 121, quiet: true, reducedMotion: true, hidden: false
  });
  assert.deepEqual(previous, { size: 200, quiet: true, reducedMotion: true, hidden: true });
  assert.equal(validatePreferences({ size: 120 }).size, 120);
  assert.equal(validatePreferences({ size: 240 }).size, 240);
});

test("the current preference validator rejects all future fields and invalid old values", () => {
  for (const value of [null, undefined, 0, "", [], true]) assert.throws(() => validatePreferences(value), TypeError);
  for (const key of ["schemaVersion", "notificationMode", "snoozedUntil", "token", "launchURL"]) {
    assert.throws(() => validatePreferences({ [key]: "private-sentinel" }), TypeError);
  }
  for (const size of [119.9, 240.1, NaN, Infinity, -Infinity, "160", null]) {
    assert.throws(() => validatePreferences({ size }), RangeError);
  }
  for (const key of ["quiet", "reducedMotion", "hidden"]) {
    assert.throws(() => validatePreferences({ [key]: 1 }), TypeError);
  }
});

test("legacy stored preferences migrate without losing size, motion or visibility", () => {
  assert.equal(PREFERENCE_SCHEMA_VERSION, 2);
  assert.equal(Object.isFrozen(DEFAULT_STORED_PREFERENCES), true);
  assert.equal(Object.isFrozen(NOTIFICATION_MODES), true);
  assert.deepEqual(migrateStoredPreferences({ size: 220.2, quiet: true, reducedMotion: true, hidden: true }), {
    ...DEFAULT_STORED_PREFERENCES, schemaVersion: 2, size: 220, notificationMode: "quiet", snoozedUntil: null,
    reducedMotion: true, hidden: true
  });
  assert.equal(migrateStoredPreferences({ quiet: false }).notificationMode, "all");
  assert.deepEqual(normalizeStoredPreferences(), DEFAULT_STORED_PREFERENCES);
  assert.notEqual(normalizeStoredPreferences(), DEFAULT_STORED_PREFERENCES);
  assert.deepEqual(migrateStoredPreferences(Object.create(null)), DEFAULT_STORED_PREFERENCES);
});

test("explicit mode takes priority over legacy quiet and canonical storage omits quiet", () => {
  for (const mode of NOTIFICATION_MODES) {
    for (const quiet of [true, false]) {
      const normalized = normalizeStoredPreferences({ schemaVersion: 2, notificationMode: mode, quiet });
      assert.equal(normalized.notificationMode, mode);
      assert.equal(Object.hasOwn(normalized, "quiet"), false);
      assert.equal(toLegacyPreferences(normalized).quiet, mode === "quiet");
    }
  }
  // An explicit mode does not excuse an invalid legacy value in the same record.
  assert.throws(() => normalizeStoredPreferences({ notificationMode: "all", quiet: "true" }), TypeError);
  assert.deepEqual(toLegacyPreferences({ size: 200, notificationMode: "attention", snoozedUntil: 9999, hidden: true }), {
    size: 200, quiet: false, reducedMotion: false, hidden: true
  });
});

test("normalization is idempotent and never mutates source preferences", () => {
  const source = Object.freeze({ schemaVersion: 2, size: 170, notificationMode: "attention", snoozedUntil: 12345, reducedMotion: true, hidden: true });
  const first = normalizeStoredPreferences(source);
  assert.deepEqual(normalizeStoredPreferences(first), first);
  assert.notEqual(first, source);
  first.hidden = false;
  assert.equal(source.hidden, true);
});

test("future storage rejects unknown versions, keys, object shapes and invalid modes", () => {
  for (const schemaVersion of [1, 3, "2", null, undefined]) {
    assert.throws(() => normalizeStoredPreferences({ schemaVersion }), TypeError);
  }
  for (const notificationMode of ["", "ALL", "silent", false, null, undefined, {}]) {
    assert.throws(() => normalizeStoredPreferences({ notificationMode }), TypeError);
  }
  for (const value of [null, [], new Date(), Object.create({ token: "private-sentinel" }), "preferences"]) {
    assert.throws(() => normalizeStoredPreferences(value), TypeError);
  }
  for (const key of ["token", "sessionId", "title", "launchURL", "__proto__", "constructor"]) {
    assert.throws(() => normalizeStoredPreferences(JSON.parse(`{"${key}":"private-sentinel"}`)), TypeError);
  }
  assert.throws(() => normalizeStoredPreferences({ [Symbol("private-sentinel")]: true }), TypeError);
  assert.throws(() => normalizeStoredPreferences(Object.defineProperty({}, "token", { value: "private-sentinel" })), TypeError);
});

test("snooze deadlines accept only null or nonnegative safe integer milliseconds", () => {
  for (const snoozedUntil of [null, 0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(normalizeStoredPreferences({ snoozedUntil }).snoozedUntil, snoozedUntil);
  }
  for (const snoozedUntil of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1800000", undefined, false]) {
    assert.throws(() => normalizeStoredPreferences({ snoozedUntil }), RangeError);
  }
});

test("future partial updates preserve previous values and prefer explicit mode over quiet", () => {
  const previous = Object.freeze({ schemaVersion: 2, size: 200, notificationMode: "attention", snoozedUntil: 30000, reducedMotion: true, hidden: true });
  const patch = Object.freeze({ size: 160.6, hidden: false });
  assert.deepEqual(validateStoredPreferencePatch(patch, previous), {
    ...DEFAULT_STORED_PREFERENCES, schemaVersion: 2, size: 161, notificationMode: "attention", snoozedUntil: 30000,
    reducedMotion: true, hidden: false
  });
  assert.equal(validateStoredPreferencePatch({ quiet: true }, previous).notificationMode, "quiet");
  assert.equal(validateStoredPreferencePatch({ quiet: false }, previous).notificationMode, "all");
  assert.equal(validateStoredPreferencePatch({ quiet: true, notificationMode: "attention" }, previous).notificationMode, "attention");
  assert.equal(validateStoredPreferencePatch({ notificationMode: "all" }, previous).snoozedUntil, 30000);
  assert.equal(validateStoredPreferencePatch({ snoozedUntil: null }, previous).notificationMode, "attention");
  assert.equal(validateStoredPreferencePatch({ snoozedUntil: null }, previous).snoozedUntil, null);
  assert.deepEqual(validateStoredPreferencePatch({}, { quiet: true }), migrateStoredPreferences({ quiet: true }));
  assert.equal(previous.size, 200);
});

test("future partial updates strictly reject metadata and sensitive unknown fields", () => {
  for (const patch of [{ schemaVersion: 2 }, { title: "private-sentinel" }, { token: "private-sentinel" }, { notificationMode: "bad" }, { quiet: "false" }]) {
    assert.throws(() => validateStoredPreferencePatch(patch), TypeError);
  }
  assert.throws(() => validateStoredPreferencePatch({ snoozedUntil: -1 }), RangeError);
  assert.throws(() => validateStoredPreferencePatch({}, { hidden: false, token: "private-sentinel" }), TypeError);
});

test("policy uses the selected mode without snooze and leaves preference data intact", () => {
  for (const mode of NOTIFICATION_MODES) {
    const preferences = Object.freeze(normalizeStoredPreferences({ notificationMode: mode }));
    assert.deepEqual(resolveNotificationPolicy(preferences, 100), {
      notificationMode: mode, effectiveMode: mode, snoozed: false, remainingMs: 0
    });
  }
});

test("snooze lasts until its exact persisted deadline without changing the selected mode", () => {
  const deadline = 1000 + 30 * 60 * 1000;
  const stored = Object.freeze(normalizeStoredPreferences({ notificationMode: "attention", snoozedUntil: deadline }));
  assert.deepEqual(resolveNotificationPolicy(stored, 1000), {
    notificationMode: "attention", effectiveMode: "quiet", snoozed: true, remainingMs: 1800000
  });
  assert.equal(resolveNotificationPolicy(stored, deadline - 1).remainingMs, 1);
  assert.deepEqual(resolveNotificationPolicy(stored, deadline), {
    notificationMode: "attention", effectiveMode: "attention", snoozed: false, remainingMs: 0
  });
  assert.equal(resolveNotificationPolicy(stored, deadline + 1).snoozed, false);
  assert.equal(stored.snoozedUntil, deadline);
  assert.equal(stored.notificationMode, "attention");
  assert.equal(resolveNotificationPolicy({ notificationMode: "quiet", snoozedUntil: deadline }, deadline).effectiveMode, "quiet");
});

test("restart reuses the deadline and wall-clock changes follow the explicit absolute-time policy", () => {
  const deadline = 1801000;
  const stored = normalizeStoredPreferences({ notificationMode: "all", snoozedUntil: deadline });
  const restarted = migrateStoredPreferences(JSON.parse(JSON.stringify(stored)));
  assert.equal(resolveNotificationPolicy(restarted, 601000).remainingMs, 1200000);
  assert.equal(resolveNotificationPolicy(restarted, deadline + 100).snoozed, false);
  // No new deadline is derived from restart time or from moving the clock back.
  assert.equal(resolveNotificationPolicy(restarted, 0).remainingMs, deadline);
  assert.equal(resolveNotificationPolicy(restarted, 500).remainingMs, deadline - 500);
  assert.equal(resolveNotificationPolicy(restarted, 1000).remainingMs, 1800000);
  assert.equal(restarted.snoozedUntil, deadline);
  assert.equal(restarted.notificationMode, "all");
});

test("clock injection rejects invalid epoch values and safely handles its integer boundary", () => {
  for (const now of [undefined, null, -1, 0.5, Infinity, NaN, "1000", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveNotificationPolicy({}, now), RangeError);
  }
  assert.equal(resolveNotificationPolicy({ snoozedUntil: Number.MAX_SAFE_INTEGER }, 0).remainingMs, Number.MAX_SAFE_INTEGER);
  assert.equal(resolveNotificationPolicy({ snoozedUntil: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER).remainingMs, 0);
  assert.equal(resolveNotificationPolicy({ snoozedUntil: 0 }, 0).snoozed, false);
});
