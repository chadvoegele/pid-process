import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

export async function connectAcp(path) {
	const socket = createConnection(path);
	await once(socket, "connect");
	let nextId = 0;
	const pending = new Map();
	const updates = [];
	const send = (message) =>
		socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			pending.set(id, { resolve, reject });
			send({ id, method, params });
		});
	createInterface({ input: socket }).on("line", (line) => {
		const message = JSON.parse(line);
		if (message.method === "session/update") updates.push(message.params);
		const call = pending.get(message.id);
		if (!call) return;
		pending.delete(message.id);
		if (message.error) call.reject(new Error(message.error.message));
		else call.resolve(message.result);
	});
	socket.on("error", () => {});
	socket.on("close", () => {
		for (const { reject } of pending.values())
			reject(new Error("ACP connection closed"));
	});
	await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
	return {
		updates,
		close: () => socket.destroy(),
		async open(cwd, sessionId) {
			const params = { cwd, mcpServers: [] };
			if (sessionId) {
				await request("session/load", { ...params, sessionId });
				return sessionId;
			}
			return (await request("session/new", params)).sessionId;
		},
		prompt(sessionId, text) {
			return request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text }],
			});
		},
		cancel(sessionId) {
			send({ method: "session/cancel", params: { sessionId } });
		},
	};
}
