import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

const root = process.env.PROCESS_TEST_ROOT;
const faux = fauxProvider({ models: [{ id: "fixture" }] });

function textOf(content) {
	return typeof content === "string"
		? content
		: content.map((block) => block.text ?? "").join("");
}

async function respond({ messages }, options, state) {
	const last = messages.findLast((message) => message.role !== "system");
	if (last.role === "toolResult") {
		const text = textOf(last.content);
		await appendFile(
			join(root, "model.jsonl"),
			`${JSON.stringify({ tool: text })}\n`,
		);
		return fauxAssistantMessage(`Tool reply: ${text}`);
	}
	const text = textOf(last.content);
	const inputs = messages
		.filter((message) => message.role === "user")
		.map((message) => textOf(message.content));
	await appendFile(
		join(root, "model.jsonl"),
		`${JSON.stringify({ text, inputs })}\n`,
	);
	if (text.startsWith("{")) {
		return fauxAssistantMessage(
			fauxToolCall("process", JSON.parse(text), {
				id: `job-${state.callCount}`,
			}),
			{
				stopReason: "toolUse",
			},
		);
	}
	if (text.startsWith("hold:")) {
		while (
			!options?.signal?.aborted &&
			!(await stat(join(root, "release-model")).catch(() => undefined))
		) {
			await setTimeout(10);
		}
		if (text === "hold:fail") {
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Fixture run failed",
			});
		}
		return fauxAssistantMessage("Active run answered.");
	}
	return fauxAssistantMessage(
		text.startsWith("Process job ")
			? "Completion answered."
			: "Input answered.",
	);
}

faux.setResponses(Array.from({ length: 100 }, () => respond));
export default faux.provider;
