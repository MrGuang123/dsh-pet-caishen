import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPetDrag } from '../companion/web/drag.js';

function fixture(native = true) {
  class Pet extends EventTarget {
    captured = new Set();
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) {
      this.captured.delete(id);
      emit(this, 'lostpointercapture', { pointerId: id });
    }
  }
  const pet = new Pet(), events = new EventTarget();
  const messages = [], moves = [], states = [];
  let clicks = 0;
  attachPetDrag({ pet, events, native, bridge: message => messages.push(message),
    onStart() {}, onDragging: active => states.push(active), onClick: () => clicks++,
    onBrowserMove: (dx, dy) => moves.push([dx, dy]) });
  const pointer = (type, data = {}) => emit(pet, type, { button: 0, pointerId: 1, screenX: 100, screenY: 200, ...data });
  const report = (detail) => emit(events, 'acai-drag', { detail: { id: messages[0].id, ...detail } });
  return { pet, events, messages, moves, states, pointer, report, get clicks() { return clicks; } };
}
function emit(target, type, data = {}) { target.dispatchEvent(Object.assign(new Event(type), data)); }

test('native dragging never integrates WebKit screen deltas or synthetic pointer moves', () => {
  const f = fixture();
  f.pointer('pointerdown');
  for (let i = 0; i < 200; i++) f.pointer('pointermove', { screenX: 100 - i * 5, screenY: 200 + i * 9 });
  assert.deepEqual(f.messages, [{ type: 'drag-start', id: 1 }]);
  assert.deepEqual(f.moves, []);
  f.report({ phase: 'move', moved: true });
  assert.equal(f.states.at(-1), true);
  f.pointer('pointerup');
  assert.deepEqual(f.messages.at(-1), { type: 'drag-end', id: 1, cancelled: false });
  emit(f.pet, 'click', { detail: 1 });
  f.report({ phase: 'end', moved: true, cancelled: false });
  assert.equal(f.clicks, 0);
  assert.equal(f.pet.captured.size, 0);
  assert.equal(f.states.at(-1), false);
});

test('native physical release clears capture without a WebKit pointerup, then permits another drag', () => {
  const f = fixture();
  f.pointer('pointerdown');
  f.pointer('lostpointercapture');
  assert.equal(f.messages.length, 1);
  f.report({ phase: 'end', moved: true, cancelled: false });
  f.pointer('pointerdown');
  assert.deepEqual(f.messages.at(-1), { type: 'drag-start', id: 2 });
  f.report({ phase: 'end', id: 1, moved: false, cancelled: false });
  assert.equal(f.clicks, 0);
  assert.equal(f.pet.captured.size, 1);
  f.report({ phase: 'end', id: 2, moved: true, cancelled: false });
  assert.equal(f.pet.captured.size, 0);
});

test('native tap is confirmed once and keyboard activation remains available', () => {
  const f = fixture();
  f.pointer('pointerdown');
  f.pointer('pointerup');
  emit(f.pet, 'click', { detail: 1 });
  assert.equal(f.clicks, 0);
  f.report({ phase: 'end', moved: false, cancelled: false });
  f.report({ phase: 'end', moved: false, cancelled: false });
  assert.equal(f.clicks, 1);
  emit(f.pet, 'click', { detail: 0 });
  assert.equal(f.clicks, 2);
});

test('pointer cancellation and focus loss end native gestures without petting', () => {
  for (const type of ['pointercancel', 'blur']) {
    const f = fixture();
    f.pointer('pointerdown');
    if (type === 'blur') emit(f.events, type);
    else f.pointer(type);
    assert.deepEqual(f.messages.at(-1), { type: 'drag-end', id: 1, cancelled: true });
    f.report({ phase: 'end', moved: false, cancelled: true });
    assert.equal(f.clicks, 0);
    assert.equal(f.pet.captured.size, 0);
    f.pointer('pointerdown');
    assert.equal(f.messages.at(-1).id, 2);
  }
});

test('preview keeps its movement threshold and suppresses clicks after dragging', () => {
  const f = fixture(false);
  f.pointer('pointerdown');
  f.pointer('pointermove', { screenX: 102, screenY: 201 });
  assert.equal(f.moves.length, 0);
  f.pointer('pointermove', { screenX: 106, screenY: 208 });
  f.pointer('pointermove', { screenX: 111, screenY: 206 });
  assert.deepEqual(f.moves, [[6, 8], [5, -2]]);
  f.pointer('pointerup');
  emit(f.pet, 'click', { detail: 1 });
  assert.equal(f.clicks, 0);
  f.pointer('pointerdown');
  f.pointer('pointerup');
  emit(f.pet, 'click', { detail: 1 });
  assert.equal(f.clicks, 1);
  assert.deepEqual(f.messages, []);
});

test('right button and unrelated pointers cannot initiate or stop a drag', () => {
  const f = fixture();
  f.pointer('pointerdown', { button: 2 });
  assert.equal(f.messages.length, 0);
  f.pointer('pointerdown');
  f.pointer('pointerdown', { pointerId: 2 });
  f.pointer('pointerup', { pointerId: 2 });
  assert.equal(f.messages.length, 1);
  f.pointer('pointerup');
  assert.equal(f.messages.length, 2);
});

test('locked native petting never starts a drag and still handles one click', () => {
  const pet = new EventTarget(), events = new EventTarget(), messages=[];
  let clicks=0;
  attachPetDrag({pet,events,native:true,bridge:m=>messages.push(m),isLocked:()=>true,onStart(){},onDragging(){},onClick(){clicks++;},onBrowserMove(){}});
  emit(pet,'pointerdown',{button:0,pointerId:1});emit(pet,'click',{detail:1});
  assert.equal(messages.length,0);assert.equal(clicks,1);
});
