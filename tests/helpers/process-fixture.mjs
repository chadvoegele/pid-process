import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connectAcp } from "./acp-client.mjs";

const resolveFixturePath = (name) =>
	fileURLToPath(new URL(name, import.meta.url));
export const exists = (path) =>
	stat(path).then(
		() => true,
		() => false,
	);
export const readText = (path) =>
	readFile(path, "utf8").catch((error) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});

export async function waitFor(probe, description) {
	const deadline = Date.now() + 5000;
	do {
		if (await probe()) return;
		await delay(15);
	} while (Date.now() < deadline);
	assert.fail(`Timed out waiting for ${description}`);
}

export async function createProcessFixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pid-process-"));
	const cwd = join(root, "cwd");
	const socket = join(root, "acp.sock");
	const store = join(root, "sessions");
	const clients = [];
	let child;
	let stopped;
	let stderr = "";
	await mkdir(cwd);
	async function stop(signal) {
		if (!child) return;
		child.kill(signal);
		await stopped;
		child = undefined;
	}
	t.after(async () => {
		for (const client of clients) client.close();
		await stop("SIGKILL");
		await rm(root, { recursive: true, force: true });
	});
	return {
		cwd,
		socket,
		stderr: () => stderr,
		stop,
		file: (name) => join(root, name),
		mark: (name) => writeFile(join(root, name), ""),
		storage: () => readText(join(store, "db", "main.jsonl")),
		async calls() {
			return (await readText(join(root, "model.jsonl")))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(JSON.parse);
		},
		async start(boundary) {
			// A killed Unix socket listener leaves its socket pathname behind.
			await rm(socket, { force: true });
			child = spawn(process.env.PROCESS_TEST_PID_ACP ?? "pid-acp", [], {
				stdio: ["ignore", "ignore", "pipe"],
				env: {
					PATH: process.env.PATH,
					HOME: root,
					PID_ACP_EXTENSIONS: JSON.stringify([
						resolveFixturePath(
							boundary ? "boundaries.mjs" : "../../dist/index.js",
						),
					]),
					PID_ACP_INSTRUCTIONS: "",
					PID_ACP_MCP_CONFIG: "",
					PID_ACP_MODEL: "fixture",
					PID_ACP_PROVIDER_CONFIG: resolveFixturePath("provider.mjs"),
					PID_ACP_SESSIONS_DIR: store,
					PID_ACP_SKILLS_DIR: "",
					PID_ACP_SOCKET_PATH: socket,
					PROCESS_TEST_BOUNDARY: boundary ?? "",
					PROCESS_TEST_ROOT: root,
				},
			});
			child.stderr.setEncoding("utf8").on("data", (data) => {
				stderr += data;
			});
			stopped = once(child, "close");
			// Fail on early exit instead of waiting for a socket that cannot appear.
			await waitFor(async () => {
				assert.equal(child.exitCode, null, stderr);
				return exists(socket);
			}, "pid-acp's socket");
		},
		async connect() {
			const client = await connectAcp(socket);
			clients.push(client);
			return client;
		},
	};
}

export const quoteShellPath = (path) => `'${path.replaceAll("'", "'\\''")}'`;
export const promptProcess = (acp, id, command, timeout = 5) =>
	acp.prompt(id, JSON.stringify({ command, timeout }));
export const readCompletions = async (fixture) =>
	(await fixture.calls()).filter(({ text }) =>
		text?.startsWith("Process job "),
	);
export const readAssistantText = (acp, id) =>
	acp.updates
		.filter(
			({ sessionId, update }) =>
				sessionId === id && update.sessionUpdate === "agent_message_chunk",
		)
		.map(({ update }) => update.content.text)
		.join("");
export const waitForCommandRelease = (fixture) =>
	`for i in {1..200}; do [ -f ${quoteShellPath(fixture.file("release-command"))} ] && break; sleep .02; done`;

export async function readJobId(fixture) {
	const tool = (await fixture.calls()).findLast(({ tool }) =>
		tool?.match(/Process job .* admitted\./),
	)?.tool;
	return tool?.match(/Process job (.*?) admitted\./)?.[1];
}
