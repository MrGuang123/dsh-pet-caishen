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
let preferences = { size: 160, quiet: false, reducedMotion: false, hidden: false };
let previousActivityKey = '';
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
  $('#status-text').textContent = labels[state];
  const connectionText = demo ? '演示模式 · 未代表真实任务' : isConnected() ? '已连接 DSH · 陪你一起开工' : 'DSH 暂未连接';
  $('#connection-text').textContent = connectionText;
  $('#demo-panel').hidden = !demo;
  $('#demo-badge').hidden = !demo;
  $('#status').setAttribute('aria-label', `${labels[state]}。点击查看详情${demo ? '。当前为演示模式' : ''}`);
  document.querySelectorAll('[data-demo]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.demo === state)));
  scheduleZones();
}

function applyPreferences(next) {
  const wasQuiet = preferences.quiet;
  preferences = { ...preferences, ...next };
  const size = Number(preferences.size);
  preferences.size = Number.isFinite(size) ? Math.max(120, Math.min(240, size)) : 160;
  document.body.classList.toggle('large-pet', preferences.size >= 220);
  document.documentElement.style.setProperty('--pet-size', `${preferences.size}px`);
  $('#size').value = preferences.size;
  $('#size-value').value = preferences.size;
  $('#quiet').checked = Boolean(preferences.quiet);
  $('#reduced-motion').checked = Boolean(preferences.reducedMotion);
  companion.classList.toggle('reduced-motion', Boolean(preferences.reducedMotion));
  if (preferences.quiet && !wasQuiet) dismissBubble();
  clampBrowserPosition();
  scheduleZones();
}

function queuePreference(change, immediate = false) {
  lastPreferenceEdit = Date.now();
  applyPreferences(change);
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

function showBubble(text, { session = false, automatic = false, duration = 5500 } = {}) {
  if (automatic && (preferences.quiet || !settings.hidden)) return;
  clearTimeout(bubbleTimer);
  $('#bubble-text').textContent = text;
  $('#bubble-open').hidden = !(session && snapshot?.activity?.sessionId);
  bubble.hidden = false;
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

function showStatus() {
  const status = visualState();
  const activity = snapshot?.activity;
  const detail = !isConnected() && !demo ? messages.offline : activity?.detail || activity?.title || messages[status] || messages.idle;
  showBubble(demo ? `演示 · ${detail}` : detail, { session: ['waiting', 'ready', 'blocked', 'running'].includes(status), duration: 6500 });
}

function setMenu(open) {
  settings.hidden = !open;
  companion.classList.toggle('menu-open', open);
  $('#menu-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    dismissBubble();
    $('#settings-error').hidden = true;
  }
  scheduleZones();
}

async function openSession() {
  if (demo) {
    showError('当前为演示模式，没有真实 DSH 会话。');
    return;
  }
  if (native && !snapshot?.activity?.sessionId) {
    bridge({ type: 'open-dsh' });
    dismissBubble();
    setMenu(false);
    return;
  }
  try {
    await request('/api/action', { type: 'open-session', ...(snapshot?.activity?.sessionId ? { sessionId: snapshot.activity.sessionId } : {}) });
    dismissBubble();
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
    setMenu(false);
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; }
}

async function interact() {
  lastInteraction = Date.now();
  petUntil = Date.now() + 1900;
  render();
  showBubble(['掌柜，今天也一起好好开工。', '收到摸摸，财气 +1。', '阿财在呢，有事尽管招呼。'][Math.floor(Math.random() * 3)]);
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
  try {
    const next = await request('/api/state');
    if (next.version !== 1 || !next.connection || !next.activity) throw new Error('阿财和服务的版本暂不兼容。');
    snapshot = next;
    demo = requestedDemo || next.connection.mode === 'demo';
    if (!Object.keys(preferenceQueue).length && !preferenceTimer && Date.now() - lastPreferenceEdit > 1800) applyPreferences(next.preferences || {});
    const key = `${next.connection.connected}:${next.activity.status}:${next.activity.sessionId || ''}:${next.activity.updatedAt || ''}`;
    if (key !== previousActivityKey) {
      const status = activityStatus();
      if (previousActivityKey && !demo && ['waiting', 'ready', 'blocked'].includes(status)) {
        showBubble(`${demo ? '演示 · ' : ''}${messages[status]}`, { session: true, automatic: true });
      }
      previousActivityKey = key;
    }
    render();
  } catch (error) {
    if (snapshot) snapshot = { ...snapshot, connection: { ...snapshot.connection, connected: false } };
    // A failed service request must never leave a stale “working” status behind.
    demo = false;
    render();
    $('#connection-text').textContent = error.message || 'DSH 暂未连接';
  } finally {
    setTimeout(poll, 1000);
  }
}

function scheduleZones() {
  if (!native || zonesFrame) return;
  zonesFrame = requestAnimationFrame(() => {
    zonesFrame = null;
    const footprint = horizontalFootprint([pet, $('#status'), $('#pet-tools')].map(element => element.getBoundingClientRect()), innerWidth);
    const encodedBounds = JSON.stringify(footprint);
    if (footprint && encodedBounds !== lastDragBounds) {
      lastDragBounds = encodedBounds;
      bridge({ type: 'drag-bounds', ...footprint });
    }
    for (const overlay of [bubble, settings]) {
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
      if (element.closest('[hidden]') || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return [];
      const tools = element.closest('.pet-tools');
      if (tools && Number(getComputedStyle(tools).opacity) < 0.05) return [];
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      return right > left && bottom > top ? [{ x: Math.round(left), y: Math.round(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) }] : [];
    });
    // Bubbles have a visible surface even when they have no open-session button.
    for (const element of [bubble, settings]) {
      if (!element.hidden) {
        const rect = element.getBoundingClientRect();
        zones.push({ x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
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
  pet, events: window, native, bridge,
  onStart: () => { lastInteraction = Date.now(); },
  onDragging: (active) => { companion.classList.toggle('dragging', active); scheduleZones(); },
  onClick: interact,
  onBrowserMove: (dx, dy) => {
    browserOffset.x += dx;
    browserOffset.y += dy;
    clampBrowserPosition();
  },
});
pet.addEventListener('contextmenu', (event) => { event.preventDefault(); setMenu(settings.hidden); });
$('.pet-wrap').addEventListener('pointerenter', () => { scheduleZones(); setTimeout(scheduleZones, 190); });
$('.pet-wrap').addEventListener('pointerleave', () => { scheduleZones(); setTimeout(scheduleZones, 190); });
$('#menu-toggle').addEventListener('click', () => setMenu(settings.hidden));
$('#menu-close').addEventListener('click', () => { setMenu(false); $('#menu-toggle').focus(); });
$('#status').addEventListener('click', showStatus);
$('#fortune').addEventListener('click', fortune);
$('#return-session').addEventListener('click', returnToLastSession);
$('#open-session').addEventListener('click', openSession);
$('#bubble-open').addEventListener('click', openSession);
$('#size').addEventListener('input', (event) => queuePreference({ size: Number(event.target.value) }));
$('#quiet').addEventListener('change', (event) => queuePreference({ quiet: event.target.checked }, true));
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
  if (!settings.hidden && !settings.contains(event.target) && !$('#menu-toggle').contains(event.target)) setMenu(false);
});
document.addEventListener('keydown', (event) => {
  lastInteraction = Date.now();
  if (event.key === 'Escape') { setMenu(false); dismissBubble(); }
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
  coin.setAttribute('aria-hidden', 'true');
  coin.style.left = `calc(50% + ${34 + Math.round(Math.random() * 8 - 4)}px)`;
  wrap.append(coin);
  const remove = () => coin.remove();
  coin.addEventListener('animationend', remove, { once: true });
  setTimeout(remove, 1300);
}
window.__ACAI_ANIMATE__ = (name) => { if (name === 'coin') playCoin(); };

try {
  await mountCharacter($('#character'));
} catch (error) {
  showBubble(error.message, { duration: 15000 });
}
applyPreferences(preferences);
render();
bridge({ type: 'ready' });
poll();
