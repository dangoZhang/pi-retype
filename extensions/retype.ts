import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RetypeRunner } from "./runtime.ts";

const PACKAGE_PROMPT = fileURLToPath(new URL("../prompts/retype.md", import.meta.url));
const MODEL_TOOLS = ["retype", "retype_job"];

async function readPrompt(cwd: string, agentDir: string): Promise<string> {
	for (const path of [join(cwd, ".pi", "retype.md"), join(agentDir, "retype.md"), PACKAGE_PROMPT]) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return "";
}

function renderRun(snapshot: NonNullable<ReturnType<RetypeRunner["get"]>>): string {
	if (snapshot.status === "completed" && !snapshot.resultTruncated) return snapshot.result ?? "null";
	if (snapshot.status === "completed") {
		return JSON.stringify({
			status: snapshot.status,
			job_id: snapshot.id,
			result_truncated: true,
			result_bytes: snapshot.resultBytes,
			result_preview: snapshot.result,
		});
	}
	return JSON.stringify({ status: snapshot.status, job_id: snapshot.id, error: snapshot.error });
}

export default function retypeExtension(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const runner = new RetypeRunner(pi, agentDir);
	const lockModelTools = () => {
		const active = pi.getActiveTools();
		if (active.length !== MODEL_TOOLS.length || MODEL_TOOLS.some((name) => !active.includes(name))) {
			pi.setActiveTools(MODEL_TOOLS);
		}
	};

	pi.on("session_start", lockModelTools);

	pi.on("before_agent_start", async (event, ctx) => {
		lockModelTools();
		const prompt = await readPrompt(ctx.cwd, agentDir);
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "retype" && event.toolName !== "retype_job") {
			return { block: true, reason: `Use ${event.toolName} through a Retype TypeScript action.` };
		}
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "retype") return;
		const details = event.details as { status?: string } | undefined;
		if (details?.status === "failed" || details?.status === "cancelled") return { isError: true };
	});

	pi.on("session_shutdown", () => {
		runner.shutdown();
	});

	pi.registerTool({
		name: "retype",
		label: "Retype",
		description:
			"Run a TypeScript action that calls Pi tools. This is the only model-facing path for reads, searches, commands, edits, tests, and registered tools.",
		promptSnippet: "Run a TypeScript action that can call active Pi tools",
		promptGuidelines: [
			"All tool use must happen inside retype TypeScript actions; never call read, bash, edit, write, grep, find, ls, or registered tools directly.",
			"End a Retype stage when fresh model judgment is needed, then call Retype again for the next stage.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "Body of an async TypeScript function; return the final JSON-serializable result" }),
			timeout_ms: Type.Optional(
				Type.Number({ description: "Estimated foreground runtime in milliseconds; execution continues as a background job after this" }),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runner.run(params.code, params.timeout_ms, ctx, signal);
			return {
				content: [{ type: "text", text: renderRun(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "retype_job",
		label: "Retype job",
		description: "List, inspect, or cancel Retype background jobs.",
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "list (default), get, or cancel" })),
			id: Type.Optional(Type.String({ description: "Job id for get or cancel" })),
		}),
		async execute(_toolCallId, params) {
			const action = params.action ?? "list";
			let value: unknown;
			if (action === "list") value = runner.list();
			else {
				if (!params.id) throw new Error(`${action} requires a job id`);
				if (action === "get") value = runner.get(params.id);
				else if (action === "cancel") value = runner.cancel(params.id);
				else throw new Error(`Unknown retype_job action ${action}`);
			}
			return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
		},
	});

	pi.registerCommand("retype", {
		description: "Show Retype jobs or inspect/cancel one: /retype [id|cancel id]",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			try {
				const value =
					words[0] === "cancel" && words[1]
						? runner.cancel(words[1])
						: words[0]
							? runner.get(words[0])
							: runner.list();
				ctx.ui.notify(JSON.stringify(value, null, 2), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
