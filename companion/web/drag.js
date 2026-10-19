/** Native gestures use only begin/end messages. AppKit owns cursor coordinates,
 * movement thresholds and release detection, including lost WebKit events. */
export function attachPetDrag({ pet, events, native, bridge, onStart, onDragging, onClick, onBrowserMove }) {
  let gesture = null;
  let sequence = 0;
  let suppressClick = false;

  function clear() {
    const previous = gesture;
    gesture = null;
    onDragging(false);
    if (previous && pet.hasPointerCapture(previous.pointerId)) pet.releasePointerCapture(previous.pointerId);
  }

  pet.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || gesture) return;
    onStart();
    suppressClick = false;
    sequence = sequence % 1_000_000_000 + 1;
    gesture = { id: sequence, pointerId: event.pointerId, startX: event.screenX, startY: event.screenY,
      lastX: event.screenX, lastY: event.screenY, moved: false, ending: false };
    pet.setPointerCapture(event.pointerId);
    if (native) bridge({ type: 'drag-start', id: gesture.id });
  });

  pet.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId || gesture.ending || native) return;
    const distance = Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY);
    if (!gesture.moved && distance < 5) return;
    gesture.moved = true;
    onDragging(true);
    onBrowserMove(event.screenX - gesture.lastX, event.screenY - gesture.lastY);
    gesture.lastX = event.screenX;
    gesture.lastY = event.screenY;
  });

  function end(event) {
    if (!gesture || gesture.ending || (event.pointerId !== undefined && event.pointerId !== gesture.pointerId)) return;
    // Moving WKWebView can lose DOM capture. AppKit continues following the
    // physical button and finishes the gesture even without a DOM pointerup.
    if (native && event.type === 'lostpointercapture') return;
    const cancelled = event.type !== 'pointerup';
    if (native) {
      gesture.ending = true;
      bridge({ type: 'drag-end', id: gesture.id, cancelled });
      if (cancelled) clear();
    } else {
      suppressClick = gesture.moved || cancelled;
      clear();
    }
  }
  pet.addEventListener('pointerup', end);
  pet.addEventListener('pointercancel', end);
  pet.addEventListener('lostpointercapture', end);
  events.addEventListener('blur', end);

  events.addEventListener('acai-drag', ({ detail }) => {
    if (!native || !gesture || detail?.id !== gesture.id) return;
    if (detail.phase === 'move') onDragging(true);
    if (detail.phase === 'end') {
      clear();
      if (!detail.moved && !detail.cancelled) onClick();
    }
  });
  pet.addEventListener('click', (event) => {
    // Keyboard activation has no pointer gesture. Native mouse clicks are
    // confirmed above so asynchronous pointer events cannot turn a drag into a pat.
    if (event.detail === 0 || (!native && !suppressClick)) onClick();
  });
}
