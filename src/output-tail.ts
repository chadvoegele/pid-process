import { Buffer } from "node:buffer";

export function createOutputTail() {
	const maxOutputBytes = 8 * 1024;
	let tail = Buffer.alloc(0);
	let truncated = false;
	return {
		append(text: string) {
			const chunk = Buffer.from(text, "utf8");
			if (tail.length + chunk.length <= maxOutputBytes) {
				tail = Buffer.concat([tail, chunk]);
				return;
			}
			truncated = true;
			const keep = Math.max(0, maxOutputBytes - chunk.length);
			tail = Buffer.concat([
				tail.subarray(tail.length - keep),
				chunk.subarray(Math.max(0, chunk.length - maxOutputBytes)),
			]);
		},
		read() {
			let start = 0;
			while ((tail[start] & 0xc0) === 0x80) start++;
			return { output: tail.toString("utf8", start), truncated };
		},
	};
}
