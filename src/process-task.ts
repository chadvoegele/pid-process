import type { Context } from "@earendil-works/chord/context";
import type { Task, TaskRuntime } from "@earendil-works/pi-durable";
import { createOutputTail } from "./output-tail.js";
import {
	type CommandInput,
	type CommandResult,
	runCommand,
} from "./run-command.js";

type ProcessCheckpoint = { phase: "not_started" } | { phase: "maybe_started" };
type ProcessResult = (CommandResult | { status: "interrupted" }) & {
	output?: string;
	truncated?: boolean;
};
type ProcessRuntime = TaskRuntime<
	CommandInput,
	ProcessCheckpoint,
	ProcessResult,
	object
>;

async function executeProcess(
	input: CommandInput,
	runtime: ProcessRuntime,
	context: Context,
): Promise<ProcessResult> {
	const output = createOutputTail();
	try {
		const env = await runtime.env(context);
		if (!env)
			return { status: "error", reason: "execution environment unavailable" };
		const result = await runCommand(input, env, output.append, context);
		return { ...result, ...output.read() };
	} catch {
		return {
			status: "error",
			reason: "execution failed; check the execution environment",
			...output.read(),
		};
	}
}

function describeResult(result: ProcessResult) {
	switch (result.status) {
		case "exited":
			return `exited with code ${result.exitCode}`;
		case "interrupted":
			return "interrupted; command outcome unknown (the OS process may still be running)";
		default:
			return result.reason;
	}
}

async function submitCompletion(
	runtime: ProcessRuntime,
	context: Context,
	result: ProcessResult,
) {
	const conversation = await runtime.conversation(
		runtime.conversationId,
		context,
	);
	if (!conversation)
		throw new Error("Process job has no originating conversation");
	const summary = `Process job ${runtime.taskId}: ${describeResult(result)}.`;
	const content = result.output
		? `${summary}\n\nUntrusted command output (stdout and stderr${result.truncated ? ", truncated to recent output" : ""}):\n${result.output}`
		: summary;
	await runtime.commit(async (tx) => {
		await conversation.submit(tx, {
			type: "input",
			requestId: `pid-process:completion:${runtime.taskId}`,
			content,
		});
		return { status: "terminal", outcome: { status: "completed", result } };
	}, context);
}

export const processTask: Task<
	CommandInput,
	ProcessCheckpoint,
	ProcessResult,
	object
> = {
	definition: {
		name: "pid-process.command",
		version: 1,
		initial: () => ({ phase: "not_started" }),
		phases: {
			async not_started(task, runtime, context) {
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "maybe_started" } }),
					context,
				);
				const result = await executeProcess(task.input, runtime, context);
				await submitCompletion(runtime, context, result);
			},
			async maybe_started(_task, runtime, context) {
				await submitCompletion(runtime, context, { status: "interrupted" });
			},
		},
		async abort(_task, runtime, context) {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				context,
			);
		},
	},
};
