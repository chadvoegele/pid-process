import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { test } from "node:test";
import {
	createProcessFixture,
	readJobId,
	readCompletions,
	readAssistantText,
	promptProcess,
	waitForCommandRelease,
	waitFor,
} from "./helpers/process-fixture.mjs";

test("real ACP validates admission, returns early, and delivers only to the origin", {
	timeout: 15000,
}, async (t) => {
	const fixture = await createProcessFixture(t);
	await fixture.start();
	const acp = await fixture.connect();
	const origin = await acp.open(fixture.cwd);
	const other = await acp.open(fixture.cwd);
	await acp.prompt(
		origin,
		JSON.stringify({ command: "printf should-not-run" }),
	);
	assert.equal(await readJobId(fixture), undefined);
	assert.doesNotMatch(await fixture.storage(), /pid-process\.command/);

	await promptProcess(
		acp,
		origin,
		`${waitForCommandRelease(fixture)}; printf 'stdout:%s\\n' "$PWD"; printf 'stderr\\n' >&2`,
	);
	const jobId = await readJobId(fixture);
	assert.ok(jobId);
	assert.equal((await readCompletions(fixture)).length, 0);
	await fixture.mark("release-command");
	await waitFor(
		() => readAssistantText(acp, origin).includes("Completion answered."),
		"idle completion answer over ACP",
	);
	const [completion] = await readCompletions(fixture);
	assert.ok(
		completion.text.startsWith(`Process job ${jobId}: exited with code 0.`),
	);
	assert.match(completion.text, /Untrusted command output/);
	assert.ok(completion.text.includes(`stdout:${fixture.cwd}\n`));
	assert.ok(completion.text.includes("stderr\n"));
	assert.doesNotMatch(readAssistantText(acp, other), /Completion answered/);
	assert.doesNotMatch(fixture.stderr(), /stdout:|stderr\n/);
});

test("real runner reports nonzero exit, bounded mixed UTF-8, timeouts and launch failure", {
	timeout: 20000,
}, async (t) => {
	const fixture = await createProcessFixture(t);
	await fixture.start();
	const acp = await fixture.connect();
	const id = await acp.open(fixture.cwd);
	async function check(index, command, timeout, summary) {
		await promptProcess(acp, id, command, timeout);
		await waitFor(
			async () => (await readCompletions(fixture)).length >= index,
			summary.source,
		);
		const result = (await readCompletions(fixture))[index - 1].text;
		assert.match(result, summary);
		await waitFor(
			() =>
				readAssistantText(acp, id).split("Completion answered.").length > index,
			"completion answer",
		);
		return result;
	}
	const result = await check(
		1,
		"printf '€%.0s' {1..4000}; sleep .08; printf '🪐' >&2; sleep .08; printf '尾'; exit 7",
		5,
		/exited with code 7/,
	);
	assert.match(result, /truncated to recent output/);
	const output = result.split("):\n")[1];
	assert.match(output, /^€+🪐尾$/u);
	assert.ok(
		Buffer.byteLength(output) <= 8192 && Buffer.byteLength(output) > 8188,
	);
	const timeout = await check(
		2,
		"printf before-timeout; sleep 2",
		0.1,
		/timed out after 0\.1 seconds/,
	);
	assert.ok(timeout.endsWith("before-timeout"));
	await check(3, "printf should-not-run", 0, /runner rejected the timeout/);
	await rename(fixture.cwd, fixture.file("moved-cwd"));
	await check(4, "printf should-not-run", 5, /launch failed/);
	assert.doesNotMatch(fixture.stderr(), /before-timeout|🪐|should-not-run/);
});

for (const fail of [false, true]) {
	test(`busy completion uses native queue when active run ${fail ? "fails" : "answers"}`, {
		timeout: 15000,
	}, async (t) => {
		const fixture = await createProcessFixture(t);
		await fixture.start();
		const acp = await fixture.connect();
		const id = await acp.open(fixture.cwd);
		await promptProcess(
			acp,
			id,
			`${waitForCommandRelease(fixture)}; printf busy-output`,
		);
		const job = await readJobId(fixture);
		const text = fail ? "hold:fail" : "hold:answer";
		const active = acp.prompt(id, text);
		const outcome = active.catch((error) => error);
		await waitFor(
			async () => (await fixture.calls()).some((call) => call.text === text),
			"active model call",
		);
		await fixture.mark("release-command");
		await waitFor(
			async () =>
				(await fixture.storage()).includes(`pid-process:completion:${job}`),
			"durable queued completion",
		);
		assert.equal((await readCompletions(fixture)).length, 0);
		await fixture.mark("release-model");
		if (fail) {
			assert.match((await outcome).message, /Prompt failed/);
			assert.equal((await readCompletions(fixture)).length, 0);
			await acp.prompt(id, "next input");
			const next = (await fixture.calls()).find(
				({ text }) => text === "next input",
			);
			assert.equal(
				next.inputs.filter((input) => input.startsWith(`Process job ${job}:`))
					.length,
				1,
			);
		} else {
			assert.equal((await outcome).stopReason, "end_turn");
			await waitFor(
				() => readAssistantText(acp, id).includes("Completion answered."),
				"queued completion answer",
			);
			assert.ok(
				readAssistantText(acp, id).indexOf("Active run answered.") <
					readAssistantText(acp, id).indexOf("Completion answered."),
			);
			assert.equal((await readCompletions(fixture)).length, 1);
		}
	});
}

test("background job survives ordinary cancellation and ACP disconnect", {
	timeout: 15000,
}, async (t) => {
	const fixture = await createProcessFixture(t);
	await fixture.start();
	const acp = await fixture.connect();
	const id = await acp.open(fixture.cwd);
	await promptProcess(
		acp,
		id,
		`${waitForCommandRelease(fixture)}; printf detached`,
	);
	const job = await readJobId(fixture);
	const active = acp.prompt(id, "hold:answer");
	await waitFor(
		async () =>
			(await fixture.calls()).some(({ text }) => text === "hold:answer"),
		"active model call",
	);
	acp.cancel(id);
	assert.equal((await active).stopReason, "cancelled");
	acp.close();
	await fixture.mark("release-model");
	await fixture.mark("release-command");
	await waitFor(
		async () => (await readCompletions(fixture)).length === 1,
		"completion without an attachment",
	);
	const replacement = await fixture.connect();
	await replacement.open(fixture.cwd, id);
	await waitFor(
		() => readAssistantText(replacement, id).includes("Completion answered."),
		"completion shown after session/load",
	);
	assert.ok(
		(await readCompletions(fixture))[0].text.startsWith(
			`Process job ${job}: exited with code 0.`,
		),
	);
});

test("an environment lookup failure submits a completion without exposing the exception", {
	timeout: 15000,
}, async (t) => {
	const fixture = await createProcessFixture(t);
	await fixture.start("environment_error");
	const acp = await fixture.connect();
	const id = await acp.open(fixture.cwd);
	await promptProcess(acp, id, "printf should-not-run");
	await waitFor(
		() => readAssistantText(acp, id).includes("Completion answered."),
		"environment failure follow-up",
	);
	const [completion] = await readCompletions(fixture);
	assert.match(
		completion.text,
		/execution failed; check the execution environment/,
	);
	assert.doesNotMatch(completion.text, /private lookup failure|should-not-run/);
});
