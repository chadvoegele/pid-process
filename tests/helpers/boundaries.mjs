import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import extension from "../../dist/index.js";

const [tool] = extension.tools;
const [task] = extension.tasks;
const { not_started } = task.definition.phases;
const boundary = process.env.PROCESS_TEST_BOUNDARY;

async function stopAt(name, value = "") {
	await writeFile(join(process.env.PROCESS_TEST_ROOT, name), value);
	await new Promise(() => {});
}

export default {
	...extension,
	tools: [
		{
			...tool,
			execute(args, api, context) {
				return tool.execute(
					args,
					{
						...api,
						async createTask(...parameters) {
							const id = await api.createTask(...parameters);
							if (boundary === "admission")
								await stopAt("before-tool-reply", String(id));
							return id;
						},
					},
					context,
				);
			},
		},
	],
	tasks: [
		{
			definition: {
				...task.definition,
				phases: {
					...task.definition.phases,
					async not_started(record, runtime, context) {
						if (boundary === "admission" || boundary === "not_started")
							await stopAt("before-launch-checkpoint");
						if (boundary === "environment_error") {
							return not_started(
								record,
								{
									...runtime,
									async env() {
										throw new Error("private lookup failure");
									},
								},
								context,
							);
						}
						return not_started(record, runtime, context);
					},
				},
			},
		},
	],
};
