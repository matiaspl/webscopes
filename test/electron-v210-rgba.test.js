import test from "node:test";
import assert from "node:assert/strict";
import { packV210ToRgba, unpackV210FromRgba } from "../examples/electron-decklink/v210-rgba.js";

test("v210 byte packing round trips complete padded rows with opaque alpha", () => {
  const source = Uint8Array.from({ length: 256 }, (_, i) => (i * 73 + 19) & 255);
  const packed = packV210ToRgba(source, 6, 2, 128);
  assert.equal(packed.width, 43);
  assert.equal(packed.data.byteLength, 43 * 4 * 2);
  for (let i = 3; i < packed.data.byteLength; i += 4) assert.equal(packed.data[i], 255);
  const restored = unpackV210FromRgba(packed);
  assert.deepEqual(restored.data, source);
  assert.equal(restored.bytesPerRow, 128);
});

test("v210 byte packing handles a view offset and clears unused RGB bytes on reuse", () => {
  const backing = Uint8Array.from({ length: 132 }, (_, i) => i);
  const source = backing.subarray(4);
  const reuse = new Uint8Array(172).fill(231);
  const packed = packV210ToRgba(source, 6, 1, 128, reuse);
  assert.equal(packed.data[170], 0);
  assert.deepEqual(unpackV210FromRgba(packed).data, source);
});

test("v210 byte packing rejects inconsistent layout", () => {
  assert.throws(() => packV210ToRgba(new Uint8Array(16), 1920, 1, 16), /stride is invalid/);
  assert.throws(() => packV210ToRgba(new Uint8Array(15), 6, 1, 16), /truncated/);
});
