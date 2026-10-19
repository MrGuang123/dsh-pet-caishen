import test from "node:test";
import assert from "node:assert/strict";
import { horizontalFootprint, overlayShift } from "../companion/web/layout.js";

test("horizontal footprint excludes transparent padding but reserves the hover toolbar", () => {
  assert.deepEqual(horizontalFootprint([
    { left: 130, right: 290 }, { left: 108, right: 312 }, { left: 292, right: 319 }
  ], 420), { left: 108, right: 319 });
  assert.equal(horizontalFootprint([], 420), null);
});

test("screen-edge overlays move inward and remain stable on a repeated layout", () => {
  const screen = { left: 0, right: 319 };
  const shift = overlayShift({ left: 78, right: 342 }, screen);
  assert.equal(shift, -31);
  assert.equal(overlayShift({ left: 47, right: 311 }, screen, shift), shift);
  assert.equal(overlayShift({ left: 78, right: 342 }, { left: 108, right: 420 }), 38);
});
