import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { processTask } from "./process-task.js";
import type { CommandInput } from "./run-command.js";

const processTool = {
	name: "process",
	description:
		"Start a shell command in the background. Returns a job ID; the result arrives as follow-up input.",
	replay: "unsafe",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "Shell command to run" },
			timeout: { type: "number", description: "Timeout in seconds" },
		},
		required: ["command", "timeout"],
	},
	async execute(args: CommandInput, api, context) {
		const jobId = await api.createTask(
			processTask,
			args,
			{
				ownership: { kind: "conversation" },
				background: true,
			},
			context,
		);
		return {
			output: [{ type: "text", text: `Process job ${jobId} admitted.` }],
		};
	},
} satisfies ToolRegistration;

export default {
	name: "pid-process",
	tools: [processTool],
	tasks: [processTask],
} satisfies Extension;
