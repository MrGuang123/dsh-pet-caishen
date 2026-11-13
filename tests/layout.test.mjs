import test from "node:test";
import assert from "node:assert/strict";
import { horizontalFootprint, verticalFootprint, overlayShift } from "../companion/web/layout.js";

test("horizontal footprint excludes transparent padding but reserves the hover toolbar", () => {
  assert.deepEqual(horizontalFootprint([
    { left: 130, right: 290 }, { left: 108, right: 312 }, { left: 292, right: 319 }
  ], 420), { left: 108, right: 319 });
  assert.equal(horizontalFootprint([], 420), null);
});

test("vertical footprint reserves content, not transparent space", () => {
  assert.deepEqual(verticalFootprint([{ top: 210, bottom: 380 }, { top: 390, bottom: 420 }, { top: 198, bottom: 230 }], 440), { top: 198, bottom: 420 });
  assert.equal(verticalFootprint([], 440), null);
});

test("overlays move inside the visible top edge and return when there is room", () => {
  const rect = { left: 120, right: 190 };
  assert.equal(overlayShift(rect, { left: 200, right: 440 }), 88);
  assert.equal(overlayShift(rect, { left: 0, right: 440 }), 0);
});

test("screen-edge overlays move inward and remain stable on a repeated layout", () => {
  const screen = { left: 0, right: 319 };
  const shift = overlayShift({ left: 78, right: 342 }, screen);
  assert.equal(shift, -31);
  assert.equal(overlayShift({ left: 47, right: 311 }, screen, shift), shift);
  assert.equal(overlayShift({ left: 78, right: 342 }, { left: 108, right: 420 }), 38);
});
