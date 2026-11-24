import type { Context } from "@earendil-works/chord/context";
import type {
	ExecutionError,
	Shell,
	ShellExecOptions,
} from "@earendil-works/pi-durable/env";

export type CommandInput = { command: string; timeout: number };
export type CommandResult =
	| { status: "exited"; exitCode: number }
	| { status: "error"; reason: string };

function describeExecutionError(error: ExecutionError, timeout: number) {
	switch (error.code) {
		case "timeout":
			// Durable uses the same error code for invalid and elapsed timeouts.
			return error.message.startsWith("Invalid timeout:")
				? "runner rejected the timeout"
				: `timed out after ${timeout} seconds`;
		case "spawn_error":
		case "shell_unavailable":
			return "launch failed; check the shell and working directory";
		case "aborted":
			return "execution aborted";
		default:
			return "execution failed; check the execution environment";
	}
}

export async function runCommand(
	{ command, timeout }: CommandInput,
	env: Pick<Shell, "exec">,
	onOutput: ShellExecOptions["onOutput"],
	context: Context,
): Promise<CommandResult> {
	const result = await env.exec(command, { timeout, onOutput }, context);
	if (result.ok) return { status: "exited", exitCode: result.value.exitCode };
	return {
		status: "error",
		reason: describeExecutionError(result.error, timeout),
	};
}
