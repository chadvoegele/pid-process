import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createProcessFixture,
	readJobId,
	readCompletions,
	readAssistantText,
	promptProcess,
	waitForCommandRelease,
	quoteShellPath,
	readText,
	exists,
	waitFor,
} from "./helpers/process-fixture.mjs";

function assertCompletionCommittedOnce(storage, job) {
	const commits = storage.split("\n").slice(0, -1).map(JSON.parse);
	const requestId = `pid-process:completion:${job}`;
	const admissions = commits.filter(({ writes }) =>
		writes?.some(
			({ type, value }) =>
				type === "submission" && value.requestId === requestId,
		),
	);
	assert.equal(
		new Set(
			admissions.flatMap(({ writes }) =>
				writes
					.filter(
						({ type, value }) =>
							type === "submission" && value.requestId === requestId,
					)
					.map(({ value }) => value.id),
			),
		).size,
		1,
	);
	assert.ok(
		admissions[0].writes.some(
			({ type, value }) =>
				type === "task" &&
				String(value.id) === job &&
				value.state.status === "terminal",
		),
		"first completion submission and terminal job share a commit",
	);
}

for (const boundary of [
	"admission",
	"not_started",
	"maybe_started",
	"complete",
]) {
	test(`SIGKILL recovery at ${boundary}`, { timeout: 20000 }, async (t) => {
		const fixture = await createProcessFixture(t);
		const wrapped = boundary === "admission" || boundary === "not_started";
		await fixture.start(wrapped ? boundary : undefined);
		const acp = await fixture.connect();
		const id = await acp.open(fixture.cwd);
		const launches = fixture.file("launches");
		const prompt = promptProcess(
			acp,
			id,
			`printf 'start\\n' >> ${quoteShellPath(launches)}; ${waitForCommandRelease(fixture)}; printf recovered`,
		);
		const outcome = prompt.catch((error) => error);
		if (wrapped) {
			await waitFor(
				() => exists(fixture.file("before-launch-checkpoint")),
				"job that has not started",
			);
			assert.equal(await exists(launches), false);
		}
		if (boundary === "admission") {
			await waitFor(
				() => exists(fixture.file("before-tool-reply")),
				"admitted job without tool reply",
			);
			assert.equal(await readJobId(fixture), undefined);
		} else {
			assert.equal((await outcome).stopReason, "end_turn");
		}
		if (boundary === "maybe_started")
			await waitFor(() => exists(launches), "first launch");
		const admitted =
			boundary === "admission"
				? await readText(fixture.file("before-tool-reply"))
				: await readJobId(fixture);
		assert.ok(admitted);
		if (boundary === "complete") {
			await fixture.mark("release-command");
			await waitFor(
				() => readAssistantText(acp, id).includes("Completion answered."),
				"committed completion answer",
			);
		}
		await fixture.stop("SIGKILL");
		await outcome;
		await fixture.mark("release-command");
		await fixture.start();
		const resumed = await fixture.connect();
		await resumed.open(fixture.cwd, id);
		await waitFor(
			() => readAssistantText(resumed, id).includes("Completion answered."),
			"completion after restart",
		);
		assert.equal(await readText(launches), "start\n");
		const delivered = await readCompletions(fixture);
		assert.equal(delivered.length, 1);
		assert.match(
			delivered[0].text,
			boundary === "maybe_started"
				? /interrupted; command outcome unknown/
				: /exited with code 0/,
		);
		assert.equal(
			(await fixture.calls()).filter(({ text }) => text?.startsWith("{"))
				.length,
			1,
		);
		const job = delivered[0].text.match(/^Process job (.*?): /)[1];
		assert.equal(job, admitted);
		assertCompletionCommittedOnce(await fixture.storage(), job);
	});
}
