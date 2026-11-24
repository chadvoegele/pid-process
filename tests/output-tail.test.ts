import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { createOutputTail } from "../dist/output-tail.js";

const outputLimit = 8 * 1024;

test("keeps chunks in arrival order up to the byte limit", () => {
	const tail = createOutputTail();
	const first = "a".repeat(outputLimit - 3);
	tail.append(first);
	tail.append("€");
	assert.deepEqual(tail.read(), { output: `${first}€`, truncated: false });
});

test("keeps the newest bytes across multiple chunks", () => {
	const tail = createOutputTail();
	tail.append("a".repeat(outputLimit));
	tail.append("bc");
	assert.deepEqual(tail.read(), {
		output: `${"a".repeat(outputLimit - 2)}bc`,
		truncated: true,
	});
});

test("drops an incomplete leading character when truncating", () => {
	const tail = createOutputTail();
	tail.append("discarded");
	tail.append("€".repeat(outputLimit));
	const { output, truncated } = tail.read();
	assert.equal(output, "€".repeat(Math.floor(outputLimit / 3)));
	assert.ok(Buffer.byteLength(output) <= outputLimit);
	assert.equal(truncated, true);
});
