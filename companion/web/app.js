import { DEFAULT_STORED_PREFERENCES, resolveNotificationPolicy, normalizeStoredPreferences, validateStoredPreferencePatch } from './preference-schema.js';
import { activityKey, canNotify, fixedTarget, taskDetail, taskCounts } from './experience.js';
import { mountCharacter } from './character.js';
import { horizontalFootprint, overlayShift } from './layout.js';
import { attachPetDrag } from './drag.js';

const $ = (selector) => document.querySelector(selector);
const native = Boolean(window.__ACAI_NATIVE__ && window.webkit?.messageHandlers?.acai);
const query = new URLSearchParams(location.search);
const requestedDemo = query.get('demo') === '1';
const stage = $('#pet-stage');
const companion = $('#companion');
const pet = $('#pet');
const settings = $('#settings');
const bubble = $('#bubble');
const allowedStatuses = new Set(['idle', 'running', 'waiting', 'ready', 'blocked', 'offline']);
const labels = { idle: '阿财陪你歇会儿', running: '正在拨算盘', waiting: '掌柜，请过目', ready: '这轮任务结束啦', blocked: '有个问题待处理', offline: '等待 DSH 连接', sleeping: '阿财打个小盹', pet: '沾点财气，好好开工' };
const messages = { idle: '掌柜，我在呢。慢慢来，也能财源滚滚。', running: '这单我盯着，掌柜先忙。', waiting: '掌柜，有件事等你拿主意。', ready: '这轮任务结束，给掌柜作个揖。', blocked: '这里遇到了点问题，掌柜来看看？', offline: '还没连上 DSH，我先在这儿候着。', sleeping: '眯一小会儿，有事叫我。' };
let snapshot = null;
let preferences = { ...DEFAULT_STORED_PREFERENCES };
let bubbleTarget = null;
let suspended = false;
let polling = false;
const notified = new Set();
const celebrated = new Set();
const systemMotion = matchMedia("(prefers-reduced-motion: reduce)");
let previousSettings = "";
let celebrationTimer;
let taskSignature = "";
let patSequence = 0;
let lastPat = 0;
let onboardingScheduled = false;
let bubbleTimer = null;
let petUntil = 0;
let lastInteraction = Date.now();
let demoOverride = null;
let demo = requestedDemo;
let browserOffset = { x: 0, y: 0 };
let zonesFrame = null;
let lastZones = '';
let preferenceTimer = null;
let preferenceQueue = {};
let lastPreferenceEdit = 0;
let lastDragBounds = '';
let visibleScreen = null;

document.body.classList.add(native ? 'native' : 'preview');
$('#quit').hidden = !native;

function bridge(message) {
  if (native) window.webkit.messageHandlers.acai.postMessage(message);
}

async function request(path, data) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(path, {
      method: data === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { 'x-acai-client': 'companion-v1', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? '连接已失效，请重新打开阿财。' : typeof result.error === 'string' ? result.error : '暂时没联系上 DSH，稍后再试试。');
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('暂时没联系上阿财服务，稍后再试试。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isConnected() {
  return Boolean(snapshot?.connection?.connected);
}

function activityStatus() {
  if (!isConnected() && !demo) return 'offline';
  const status = snapshot?.activity?.status;
  return allowedStatuses.has(status) ? status : 'offline';
}

function visualState() {
  if (Date.now() < petUntil) return 'pet';
  if (demo && demoOverride && isConnected()) return demoOverride;
  const status = activityStatus();
  return status === 'idle' && Date.now() - lastInteraction > 180000 ? 'sleeping' : status;
}

function render() {
  const state = visualState();
  companion.dataset.state = state;
  const business = activityStatus();
  const important = ['waiting', 'blocked', 'ready', 'running'].includes(business);
  $('#status-text').textContent = business === 'waiting' ? snapshot?.activity?.detail || labels.waiting : business === 'idle' && ['aborted','interrupted'].includes(snapshot?.activity?.turn?.endReason) ? '本轮已停止' : labels[important ? business : state];
  companion.dataset.business = business;
  companion.classList.toggle('important', important);
  const counts = taskCounts(snapshot?.sessions);
  $('#task-count').textContent = Object.values(counts).reduce((a,b) => a+b, 0) > 1 ? ` ${counts.waiting ? counts.waiting + '待处理 ' : ''}${counts.blocked ? counts.blocked + '问题 ' : ''}${counts.ready ? counts.ready + '待查看 ' : ''}${counts.running ? counts.running + '运行' : ''}`.trim() : '';
  const policy = resolveNotificationPolicy(preferences, Date.now());
  $('#snooze-state').textContent = policy.snoozed ? `剩余 ${Math.ceil(policy.remainingMs / 60000)} 分钟` : '';
  $('#snooze').textContent = policy.snoozed ? '恢复提醒' : '安静 30 分钟';
  renderTasks();
  const completionId = business === 'ready' && snapshot?.activity?.completion?.id;
  if (completionId && !celebrated.has(completionId) && !snapshot?.activity?.notificationPresented) {
    celebrated.add(completionId); if (policy.effectiveMode !== 'quiet' && !suspended) companion.classList.add('celebrating');
    clearTimeout(celebrationTimer); celebrationTimer = setTimeout(() => companion.classList.remove('celebrating'), 1800);
  }
  if (business !== 'ready') companion.classList.remove('celebrating');
  const connectionText = demo ? '演示模式 · 未代表真实任务' : isConnected() ? '已连接 DSH · 陪你一起开工' : 'DSH 暂未连接';
  $('#connection-text').textContent = connectionText;
  $('#demo-panel').hidden = !demo;
  $('#demo-badge').hidden = !demo;
  $('#status').setAttribute('aria-label', `${labels[business]}。点击查看任务列表${demo ? '。当前为演示模式' : ''}`);
  document.querySelectorAll('[data-demo]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.demo === state)));
  scheduleZones();
}

function applyPreferences(next) {
  const wasQuiet = resolveNotificationPolicy(preferences, Date.now()).effectiveMode === 'quiet';
  preferences = normalizeStoredPreferences({ ...preferences, ...next });
  document.body.classList.toggle('large-pet', preferences.size >= 220);
  document.documentElement.style.setProperty('--pet-size', `${preferences.size}px`);
  $('#size').value = preferences.size;
  $('#size-value').value = preferences.size;
  $('#notification-mode').value = preferences.notificationMode;
  for (const [selector, key] of [['#reduced-motion','reducedMotion'], ['#mini','mini'], ['#large-text','largeText'], ['#position-locked','positionLocked'], ['#dock-edge','dockEdge']]) $(selector).checked = preferences[key];
  $('#shortcut-key').value = preferences.shortcutKey ?? '';
  companion.classList.toggle('reduced-motion', preferences.reducedMotion || systemMotion.matches);
  companion.classList.toggle('mini', preferences.mini);
  companion.classList.toggle('large-text', preferences.largeText);
  companion.classList.toggle('small-pet', preferences.size <= 140);
  companion.classList.toggle('position-locked', preferences.positionLocked);
  if (!wasQuiet && resolveNotificationPolicy(preferences, Date.now()).effectiveMode === 'quiet') dismissBubble();
  const nativeSettings = JSON.stringify({ type: 'settings', positionLocked: preferences.positionLocked, dockEdge: preferences.dockEdge, shortcutKey: preferences.shortcutKey });
  if (nativeSettings !== previousSettings) { previousSettings = nativeSettings; bridge(JSON.parse(nativeSettings)); }
  clampBrowserPosition(); scheduleZones();
}

function queuePreference(change, immediate = false) {
  lastPreferenceEdit = Date.now();
  applyPreferences(validateStoredPreferencePatch(change, preferences));
  preferenceQueue = { ...preferenceQueue, ...change };
  clearTimeout(preferenceTimer);
  preferenceTimer = setTimeout(flushPreferences, immediate ? 0 : 180);
}

async function flushPreferences() {
  preferenceTimer = null;
  const change = preferenceQueue;
  preferenceQueue = {};
  try {
    await request('/api/preferences', change);
    $('#settings-error').hidden = true;
  } catch (error) {
    showError(error.message);
  }
}

function showBubble(text, { target = null, automatic = false, duration = 5500 } = {}) {
  if (automatic && (suspended || !settings.hidden || !$('#tasks').hidden || !$('#onboarding').hidden)) return;
  clearTimeout(bubbleTimer);
  $('#bubble-text').textContent = text;
  bubbleTarget = target && { ...target };
  $('#bubble-open').hidden = !bubbleTarget;
  $('#bubble-dismiss').hidden = !bubbleTarget?.completionId;
  bubble.hidden = false;
  bubble.querySelector('.speech-content').scrollTop = 0;
  bubbleTimer = setTimeout(dismissBubble, duration);
  scheduleZones();
}

function dismissBubble() {
  clearTimeout(bubbleTimer);
  bubble.hidden = true;
  scheduleZones();
}

function showError(text) {
  if (!settings.hidden) {
    $('#settings-error').textContent = text;
    $('#settings-error').hidden = false;
  } else showBubble(text, { duration: 6500 });
}

function showStatus(row = snapshot?.activity) {
  const detail = !isConnected() && !demo ? messages.offline : row ? `${row.title || 'DSH 会话'}\n${taskDetail(row)}` : messages.idle;
  showBubble(demo ? `演示 · ${detail}` : detail, { target: fixedTarget(row), duration: 10000 });
}
function renderTasks() {
  const list = $('#task-list');
  if ($('#tasks').hidden) return;
  const rows = snapshot?.sessions ?? [];
  const signature = JSON.stringify(rows);
  if (signature === taskSignature && list.childNodes.length) { rows.forEach((row,i) => { const label = list.querySelectorAll('.task-detail')[i]; if (label) label.textContent = taskDetail(row); }); return; }
  taskSignature = signature;
  list.replaceChildren();
  if (!rows.length) { const empty = document.createElement('p'); empty.textContent = isConnected() ? '当前没有活动任务' : '等待 DSH 连接'; list.append(empty); }
  for (const row of rows) {
    const item = document.createElement('div'); item.className = 'task-row';
    const open = document.createElement('button'); open.type = 'button'; open.dataset.hit = '';
    const title = document.createElement('strong'); title.textContent = row.title;
    const detail = document.createElement('span'); detail.className = 'task-detail'; detail.textContent = taskDetail(row);
    open.append(title, detail); const target = fixedTarget(row); open.addEventListener('click', () => openSession(target)); item.append(open);
    if (row.status === 'ready' && row.completion) { const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.dataset.hit = ''; dismiss.textContent = '收起提醒'; dismiss.addEventListener('click', () => acknowledge(target)); item.append(dismiss); }
    list.append(item);
  }
}
async function acknowledge(target) {
  if (!target?.completionId) return;
  try { await request('/api/action', { type: 'dismiss-reminder', ...target }); dismissBubble(); await poll(); $('#status').focus(); }
  catch (error) { showError(error.message); }
}

function setMenu(open) {
  settings.hidden = !open;
  companion.classList.toggle('menu-open', open);
  $('#menu-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    $('#tasks').hidden = true;
    $('#onboarding').hidden = true;
    dismissBubble();
    $('#settings-error').hidden = true;
  }
  scheduleZones();
}

async function openSession(target = fixedTarget(snapshot?.activity)) {
  if (demo) {
    showError('当前为演示模式，没有真实 DSH 会话。');
    return;
  }
  if (native && !target?.sessionId) {
    bridge({ type: 'open-dsh' });
    dismissBubble();
    $('#tasks').hidden = true;
    setMenu(false);
    return;
  }
  try {
    await request('/api/action', { type: 'open-session', ...(target || {}) });
    dismissBubble();
    $('#tasks').hidden = true;
    setMenu(false);
  } catch (error) {
    showError(error.message);
  }
}

async function returnToLastSession() {
  if (demo) { showError('当前为演示模式，没有真实 DSH 会话。'); return; }
  const button = $('#return-session');
  button.disabled = true;
  try {
    // The Host remembers the last selected DSH chat independently of task priority.
    await request('/api/action', { type: 'return-session' });
    dismissBubble();
    $('#tasks').hidden = true;
    setMenu(false);
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; }
}

async function interact() {
  if (Date.now() - lastPat < 1200) return;
  lastPat = Date.now();
  companion.dataset.gesture = ['wave','hat','stretch'][patSequence++ % 3];
  lastInteraction = Date.now();
  petUntil = Date.now() + 1900;
  render();
  if (!['waiting','blocked','ready'].includes(activityStatus())) showBubble(['掌柜，今天也一起好好开工。', '收到摸摸，财气 +1。', '阿财在呢，有事尽管招呼。'][Math.floor(Math.random() * 3)]);
  setTimeout(render, 2000);
  try {
    await request('/api/action', { type: 'interact' });
  } catch {
    // The local head-pat remains available while the service reconnects.
  }
}

async function fortune() {
  const button = $('#fortune');
  button.disabled = true;
  try {
    const response = await request('/api/action', { type: 'fortune' });
    const text = typeof response.fortune === 'string' ? response.fortune : response.fortune?.text;
    showBubble(text || snapshot?.fortune?.text || '宜小步提交，宜认真收工。', { duration: 8500 });
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const next = await request('/api/state');
    if (next.version !== 2 || !next.connection || !next.activity) throw new Error('阿财和服务的版本暂不兼容。');
    snapshot = next;
    if (!onboardingScheduled) {
      onboardingScheduled = true;
      setTimeout(() => {
        if (!preferences.onboardingSeen && !suspended && settings.hidden && $('#tasks').hidden && !['waiting','blocked','ready'].includes(activityStatus()) && resolveNotificationPolicy(preferences, Date.now()).effectiveMode !== 'quiet') {
          $('#onboarding').hidden = false; scheduleZones();
        }
      }, 1500);
    }
    demo = requestedDemo || next.connection.mode === 'demo';
    if (!Object.keys(preferenceQueue).length && !preferenceTimer && Date.now() - lastPreferenceEdit > 1800) applyPreferences(next.preferences || {});
    const mode = resolveNotificationPolicy(preferences, Date.now()).effectiveMode;
    const candidates = (next.sessions ?? []).filter(row => ['waiting','ready','blocked'].includes(row.status) && activityKey(row) && !row.notificationPresented && !notified.has(activityKey(row)));
    for (const row of candidates) notified.add(activityKey(row));
    if (candidates.length) void request('/api/action', { type: 'present-reminders', entries: candidates.map(row => ({ sessionId: row.sessionId, notificationId: row.notificationId || row.completion?.id || '' })) }).catch(() => {});
    const eligible = candidates.filter(row => canNotify(mode, row.status));
    if (!demo && eligible.length && bubble.hidden) {
      if (eligible.length > 1) showBubble(`${eligible.length} 项任务有新状态，点下方状态条查看。`, { automatic: true });
      else { const row = eligible[0]; showBubble(`${row.title}\n${taskDetail(row)}`, { target: fixedTarget(row), automatic: true }); }
    }
    if (notified.size > 500) notified.delete(notified.values().next().value);
    if (celebrated.size > 500) celebrated.delete(celebrated.values().next().value);
    render();
  } catch (error) {
    if (snapshot) snapshot = { ...snapshot, connection: { ...snapshot.connection, connected: false } };
    // A failed service request must never leave a stale “working” status behind.
    demo = false;
    render();
    $('#connection-text').textContent = error.message || 'DSH 暂未连接';
  } finally {
    polling = false;
    clearTimeout(window.__acaiPollTimer);
    window.__acaiPollTimer = setTimeout(poll, suspended ? 4000 : 1000);
  }
}

function scheduleZones() {
  if (zonesFrame) return;
  zonesFrame = requestAnimationFrame(() => {
    zonesFrame = null;
    const maxHeight = `${Math.max(96, Math.floor(stage.getBoundingClientRect().bottom - 54))}px`;
    for (const overlay of [settings, $('#tasks')]) if (overlay.style.maxHeight !== maxHeight) overlay.style.maxHeight = maxHeight;
    const bubbleHeight = `${Math.max(28, Math.floor(stage.getBoundingClientRect().top - 12))}px`;
    for (const overlay of [bubble, $('#onboarding')]) if (overlay.style.getPropertyValue('--bubble-max-height') !== bubbleHeight) overlay.style.setProperty('--bubble-max-height', bubbleHeight);
    if (!native) return;
    const footprint = horizontalFootprint([pet, $('#status'), $('#pet-tools')].filter(element => element.id === 'pet-tools' || getComputedStyle(element).visibility !== 'hidden').map(element => element.getBoundingClientRect()), innerWidth);
    const encodedBounds = JSON.stringify(footprint);
    if (footprint && encodedBounds !== lastDragBounds) {
      lastDragBounds = encodedBounds;
      bridge({ type: 'drag-bounds', ...footprint });
    }
    for (const overlay of [bubble, settings, $('#tasks'), $('#onboarding')]) {
      if (!overlay.hidden && visibleScreen) {
        const current = Number(overlay.dataset.screenShift || 0);
        const rect = overlay.getBoundingClientRect();
        const next = overlayShift({ left: rect.left - current, right: rect.right - current }, visibleScreen);
        if (Math.abs(next - current) > 0.5) {
          overlay.dataset.screenShift = String(next);
          overlay.style.setProperty('--overlay-shift-x', `${next}px`);
        }
      }
    }
    const zones = [...document.querySelectorAll('[data-hit], [data-demo]')].flatMap((element) => {
      if (element.closest('.settings, .speech-bubble') || element.closest('[hidden]') || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return [];
      const tools = element.closest('.pet-tools');
      if (tools && Number(getComputedStyle(tools).opacity) < 0.05) return [];
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      return right > left && bottom > top ? [{ x: Math.round(left), y: Math.round(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) }] : [];
    });
    // Bubbles have a visible surface even when they have no open-session button.
    for (const element of [bubble, settings, $('#tasks'), $('#onboarding')]) {
      if (!element.hidden) {
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
        const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
        if (right > x && bottom > y) zones.push({ x, y, width: right - x, height: bottom - y });
      }
    }
    const serialized = JSON.stringify(zones);
    if (serialized !== lastZones) {
      lastZones = serialized;
      bridge({ type: 'hit-zones', zones });
    }
  });
}

function clampBrowserPosition() {
  if (native) return;
  stage.style.translate = `${browserOffset.x}px ${browserOffset.y}px`;
  const rect = stage.getBoundingClientRect();
  if (rect.left < 10) browserOffset.x += 10 - rect.left;
  if (rect.right > innerWidth - 10) browserOffset.x -= rect.right - innerWidth + 10;
  if (rect.top < 30) browserOffset.y += 30 - rect.top;
  if (rect.bottom > innerHeight - 12) browserOffset.y -= rect.bottom - innerHeight + 12;
  stage.style.translate = `${browserOffset.x}px ${browserOffset.y}px`;
}

attachPetDrag({
  pet, events: window, native, bridge, isLocked: () => preferences.positionLocked,
  onStart: () => { lastInteraction = Date.now(); },
  onDragging: (active) => { companion.classList.toggle('dragging', active); scheduleZones(); },
  onClick: interact,
  onBrowserMove: (dx, dy) => {
    if (preferences.positionLocked) return;
    browserOffset.x += dx;
    browserOffset.y += dy;
    clampBrowserPosition();
  },
});
pet.addEventListener('contextmenu', (event) => { event.preventDefault(); setMenu(settings.hidden); });
$('.pet-wrap').addEventListener('pointerenter', () => { companion.classList.add('pet-hover'); scheduleZones(); setTimeout(scheduleZones, 190); });
$('.pet-wrap').addEventListener('pointerleave', () => { companion.classList.remove('pet-hover'); scheduleZones(); setTimeout(scheduleZones, 190); });
$('#menu-toggle').addEventListener('click', () => setMenu(settings.hidden));
$('#menu-close').addEventListener('click', () => { setMenu(false); $('#menu-toggle').focus(); });
$('#status').addEventListener('click', () => { setMenu(false); dismissBubble(); $('#onboarding').hidden = true; $('#tasks').hidden = !$('#tasks').hidden; render(); scheduleZones(); });
$('#fortune').addEventListener('click', fortune);
$('#return-session').addEventListener('click', returnToLastSession);
$('#open-session').addEventListener('click', () => openSession());
$('#bubble-open').addEventListener('click', () => openSession(bubbleTarget));
$('#bubble-dismiss').addEventListener('click', () => acknowledge(bubbleTarget));
$('#size').addEventListener('input', (event) => queuePreference({ size: Number(event.target.value) }));
$('#notification-mode').addEventListener('change', event => queuePreference({ notificationMode: event.target.value }, true));
$('#reduced-motion').addEventListener('change', (event) => queuePreference({ reducedMotion: event.target.checked }, true));
$('#hide').addEventListener('click', () => {
  setMenu(false);
  dismissBubble();
  if (native) bridge({ type: 'hide' });
  else { stage.hidden = true; $('#restore').hidden = false; }
  scheduleZones();
});
$('#restore').addEventListener('click', () => { stage.hidden = false; $('#restore').hidden = true; render(); });
$('#quit').addEventListener('click', () => bridge({ type: 'quit' }));
document.addEventListener('pointerdown', (event) => {
  lastInteraction = Date.now();
  if (!$('#tasks').hidden && !$('#tasks').contains(event.target) && !$('#status').contains(event.target)) $('#tasks').hidden = true;
  if (!settings.hidden && !settings.contains(event.target) && !$('#menu-toggle').contains(event.target)) setMenu(false);
});
document.addEventListener('keydown', (event) => {
  lastInteraction = Date.now();
  if (event.key === 'Escape') { setMenu(false); dismissBubble(); $('#tasks').hidden = true; $('#onboarding').hidden = true; }
});
document.querySelectorAll('[data-demo]').forEach((button) => button.addEventListener('click', async () => {
  if (!demo) return;
  const status = button.dataset.demo;
  demoOverride = status === 'sleeping' ? 'sleeping' : null;
  petUntil = 0;
  lastInteraction = Date.now();
  try {
    await request('/api/demo', { status: status === 'sleeping' ? 'idle' : status });
    const next = await request('/api/state');
    snapshot = next;
    render();
    // Keep the compact demo controls visible at the native 420 × 440 viewport.
    if (innerHeight >= 560) showBubble(`演示 · ${messages[status]}`, { duration: 4500 });
    else dismissBubble();
  } catch (error) {
    showError(error.message);
  }
}));
addEventListener('resize', () => { clampBrowserPosition(); scheduleZones(); });
addEventListener('acai-screen', (event) => {
  const bounds = event.detail;
  if (!bounds || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.right) || bounds.right <= bounds.left) return;
  visibleScreen = { left: Math.max(0, bounds.left), right: Math.min(innerWidth, bounds.right) };
  document.documentElement.style.setProperty('--screen-content-width', `${Math.max(0, visibleScreen.right - visibleScreen.left - 16)}px`);
  scheduleZones();
});
new ResizeObserver(scheduleZones).observe(companion);
new MutationObserver(scheduleZones).observe(companion, { attributes: true, childList: true, subtree: true, attributeFilter: ['hidden', 'class', 'style'] });

/** Play a one-shot coin hop when the theme's merit badge is clicked. */
function playCoin() {
  const wrap = $('.pet-wrap');
  if (!wrap) return;
  const coin = document.createElement('span');
  coin.className = 'coin-pop';
  if (suspended) return;
  coin.setAttribute('aria-hidden', 'true');
  coin.style.left = `calc(50% + ${34 + Math.round(Math.random() * 8 - 4)}px)`;
  wrap.append(coin);
  const remove = () => coin.remove();
  coin.addEventListener('animationend', remove, { once: true });
  setTimeout(remove, 1300);
}
window.__ACAI_ANIMATE__ = (name) => { if (name === 'coin') playCoin(); };

for (const [selector, key] of [['#mini','mini'], ['#large-text','largeText'], ['#position-locked','positionLocked'], ['#dock-edge','dockEdge']]) $(selector).addEventListener('change', event => queuePreference({ [key]: event.target.checked }, true));
$('#snooze').addEventListener('click', () => { const active = resolveNotificationPolicy(preferences, Date.now()).snoozed; queuePreference({ snoozedUntil: active ? null : Date.now() + 1800000 }, true); render(); });
for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const option = document.createElement('option'); option.value = letter; option.textContent = `⌃⌥⌘${letter}`; $('#shortcut-key').append(option); }
$('#shortcut-key').addEventListener('change', event => queuePreference({ shortcutKey: event.target.value || null }, true));
$('#reset-shortcut').addEventListener('click', () => queuePreference({ shortcutKey: 'A' }, true));
$('#reset-position').addEventListener('click', () => { if (native) bridge({ type: 'reset-position' }); else { browserOffset = {x:0,y:0}; clampBrowserPosition(); } });
$('#tasks-close').addEventListener('click', () => { $('#tasks').hidden = true; scheduleZones(); $('#status').focus(); });
$('#task-details').addEventListener('click', () => { $('#tasks').hidden = true; showStatus(); });
$('#show-help').addEventListener('click', () => { setMenu(false); $('#onboarding').hidden = false; scheduleZones(); });
$('#help-close').addEventListener('click', () => { $('#onboarding').hidden = true; queuePreference({ onboardingSeen: true }, true); scheduleZones(); });
$('#diagnostics').addEventListener('click', async () => { try { const data = await request('/api/diagnostics'); $('#diagnostic-text').textContent = JSON.stringify(data, null, 2); $('#diagnostic-panel').hidden = false; scheduleZones(); } catch(error) { showError(error.message); } });
$('#copy-diagnostics').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#diagnostic-text').textContent); $('#copy-diagnostics').textContent = '已复制'; } catch { showError('暂时无法复制，可选中以上诊断文字手动复制。'); } });
systemMotion.addEventListener('change', () => applyPreferences(preferences));
addEventListener('acai-visibility', event => { suspended = event.detail !== true; companion.classList.toggle('suspended', suspended); if (!suspended) { clearTimeout(window.__acaiPollTimer); void poll(); } });
addEventListener('acai-shortcut', event => { $('#shortcut-state').textContent = event.detail === 'registered' ? '快捷键可用' : event.detail === 'disabled' ? '快捷键已停用，菜单栏仍可唤回' : '快捷键冲突，请更换字母；菜单栏仍可唤回'; });

try {
  await mountCharacter($('#character'));
} catch (error) {
  $('#character').innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><circle cx="80" cy="80" r="55" fill="#b44030"/><text x="80" y="100" text-anchor="middle" font-size="56" fill="#fff1c1">财</text></svg>';
  showBubble('角色素材暂不可用，已显示备用形象。', { duration: 15000 });
}
applyPreferences(preferences);
render();
bridge({ type: 'ready' });
poll();
