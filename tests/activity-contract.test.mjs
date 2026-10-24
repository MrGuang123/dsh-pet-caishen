import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityFacts, waitingFacts } from '../lib/activity-contract.js';
import { activityKey, canNotify, fixedTarget, taskDetail, taskCounts } from '../companion/web/experience.js';

test('observed work has unknown start; confirmed turns and their completion IDs are independent', () => {
  let time = 100;
  const a = createActivityFacts({ now: () => time }), b = createActivityFacts({ now: () => time });
  assert.equal(a.observeRunning().turn.startedAt, null);
  a.start(); time = 200;
  const completed = a.end('completed');
  assert.equal(completed.turn.startedAt, 100);
  assert.equal(completed.turn.endedAt, 200);
  assert.deepEqual(a.end('completed'), completed);
  assert.equal(b.acknowledge(completed.completion.id), false);
  a.start(); a.end('completed');
  assert.equal(a.acknowledge(completed.completion.id), false);
  assert.equal(a.acknowledge(a.snapshot().completion.id), true);
  assert.equal(completed.completion.acknowledged, false);
});

test('unknown endings and errors cannot invent a completion or a start time', () => {
  const a = createActivityFacts();
  a.error(); assert.equal(a.snapshot().turn, null);
  a.end('unexpected');
  assert.equal(a.snapshot().turn.endReason, 'unknown');
  assert.equal(a.snapshot().turn.startedAt, null);
  assert.equal(a.snapshot().completion, null);
  a.start(); a.end('aborted'); assert.equal(a.snapshot().completion, null);
});

test('waiting projections are existence flags, and supplemental expiry cannot erase host facts', () => {
  assert.deepEqual(waitingFacts({ questionObserver: true, questionProjection: true, clientPending: true }), { approval: false, question: true, unknown: true });
  assert.deepEqual(waitingFacts({ approval: true, clientPending: false }), { approval: true, question: false, unknown: false });
});

test('notification identity ignores titles/timestamps; captured targets cannot follow later priority', () => {
  const row = { sessionId: 'a', status: 'ready', title: 'one', updatedAt: 1, completion: { id: 'completion-1' } };
  const target = fixedTarget(row), key = activityKey(row);
  row.title = 'two'; row.updatedAt = 2;
  assert.equal(activityKey(row), key);
  row.completion.id = 'completion-2';
  assert.deepEqual(target, { sessionId: 'a', completionId: 'completion-1' });
  assert.notEqual(activityKey(row), key);
});

test('notification modes preserve attention and duration never fabricates an unknown start', () => {
  assert.equal(canNotify('quiet', 'waiting'), false);
  assert.equal(canNotify('attention', 'waiting'), true);
  assert.equal(canNotify('attention', 'ready'), false);
  assert.equal(taskDetail({ status: 'running', detail: '工作', turn: { startedAt: null } }, 10000), '工作');
  assert.equal(taskDetail({ status: 'running', detail: '工作', turn: { startedAt: 1000 } }, 62000), '工作 · 1分01秒');
  assert.equal(taskDetail({ status: 'running', detail: '工作', turn: { startedAt: 1000 } }, 0), '工作 · 0分00秒');
  assert.deepEqual(taskCounts([{ sessionId:'a',status:'waiting' },{sessionId:'a',status:'waiting'},{sessionId:'b',status:'running'}]), {waiting:1,blocked:0,ready:0,running:1});
});
