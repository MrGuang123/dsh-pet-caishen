/** Stable horizontal footprint: transparent window padding is not a screen boundary. */
export function horizontalFootprint(rectangles, width) {
  const valid = rectangles.filter(rect => Number.isFinite(rect.left) && Number.isFinite(rect.right) && rect.right > rect.left);
  if (!valid.length) return null;
  const left = Math.max(0, Math.min(...valid.map(rect => rect.left)));
  const right = Math.min(width, Math.max(...valid.map(rect => rect.right)));
  return right > left ? { left, right } : null;
}

/** Vertical footprint in WebView coordinates, without the transparent margins. */
export function verticalFootprint(rectangles, height) {
  const valid = rectangles.filter(rect => Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && rect.bottom > rect.top);
  if (!valid.length) return null;
  const top = Math.max(0, Math.min(...valid.map(rect => rect.top)));
  const bottom = Math.min(height, Math.max(...valid.map(rect => rect.bottom)));
  return bottom > top ? { top, bottom } : null;
}

/** Shift an existing overlay inward without moving the pet's screen anchor. */
export function overlayShift(rect, visible, current = 0, margin = 8) {
  const min = visible.left + margin;
  const max = visible.right - margin;
  if (rect.left < min) return current + min - rect.left;
  if (rect.right > max) return current + max - rect.right;
  return current;
}
