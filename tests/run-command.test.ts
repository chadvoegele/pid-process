import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { runCommand } from "../dist/run-command.js";

test("passes command and timeout through to Durable unchanged", async () => {
	const input = { command: "  printf hello  ", timeout: 0 };
	const result = await runCommand(
		input,
		{
			async exec(command, options, context) {
				assert.equal(command, input.command);
				assert.equal(options?.timeout, input.timeout);
				assert.equal(context, BACKGROUND_CONTEXT);
				return {
					ok: false,
					error: new ExecutionError("timeout", "Invalid timeout: example"),
				};
			},
		},
		undefined,
		BACKGROUND_CONTEXT,
	);
	assert.deepEqual(result, {
		status: "error",
		reason: "runner rejected the timeout",
	});
});
