import assert from "node:assert/strict";
import test from "node:test";
import { add } from "./coding-syntax.mjs";

test("synthetic addition preserves positive, negative and fractional inputs", () => {
  assert.equal(add(3, 2), 5);
  assert.equal(add(-3, 2), -1);
  assert.equal(add(0.5, 0.25), 0.75);
});
