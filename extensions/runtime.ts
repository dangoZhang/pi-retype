import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface RetypeConfig {
	foregroundMs: number;
	bridgeTimeoutMs: number;
	maxOutputBytes: number;
	rules: string[];
	ruleMode: "comment" | "reject" | "off";
	interceptor?: string[];
}

export interface JobSnapshot {
	id: string;
	status: "running" | "completed" | "failed" | "cancelled";
	startedAt: string;
	finishedAt?: string;
	exitCode?: number | null;
	background: boolean;
	runDir: string;
	result?: string;
	resultBytes?: number;
	resultTruncated?: boolean;
	stdout?: string;
	stderr?: string;
	error?: string;
}

interface Job extends JobSnapshot {
	abort: AbortController;
	child?: ChildProcess;
	server?: Server;
}

interface BridgeResponse {
	ok: boolean;
	text?: string;
	data?: unknown;
	error?: string;
}

export const DEFAULT_CONFIG: RetypeConfig = {
	foregroundMs: 15_000,
	bridgeTimeoutMs: 300_000,
	maxOutputBytes: 4 * 1024,
	rules: [],
	ruleMode: "comment",
};

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const RUNTIME_PATH = fileURLToPath(new URL("../runtime/retype_runtime.mjs", import.meta.url));

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
	return value;
}

export async function loadConfig(cwd: string, agentDir: string): Promise<RetypeConfig> {
	let merged: Record<string, unknown> = {};
	for (const path of [join(agentDir, "retype.json"), join(cwd, ".pi", "retype.json")]) {
		try {
			const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				merged = { ...merged, ...(parsed as Record<string, unknown>) };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Invalid Retype config ${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	const ruleMode = merged.ruleMode;
	return {
		foregroundMs: positiveNumber(merged.foregroundMs, DEFAULT_CONFIG.foregroundMs),
		bridgeTimeoutMs: positiveNumber(merged.bridgeTimeoutMs, DEFAULT_CONFIG.bridgeTimeoutMs),
		maxOutputBytes: positiveNumber(merged.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes),
		rules: stringArray(merged.rules) ?? DEFAULT_CONFIG.rules,
		ruleMode: ruleMode === "reject" || ruleMode === "off" || ruleMode === "comment" ? ruleMode : DEFAULT_CONFIG.ruleMode,
		interceptor: stringArray(merged.interceptor),
	};
}

export function applyRules(code: string, config: RetypeConfig): string {
	if (config.ruleMode === "off" || config.rules.length === 0) return code;
	const hits = config.rules.filter((rule) => rule.length > 0 && code.includes(rule));
	if (hits.length === 0) return code;
	if (config.ruleMode === "reject") {
		throw new Error(`Retype rule rejected code containing: ${hits.join(", ")}`);
	}

	return code
		.split("\n")
		.map((line) => {
			const hit = hits.find((rule) => line.includes(rule));
			return hit ? `// retype blocked ${JSON.stringify(hit)}: ${line}` : line;
		})
		.join("\n");
}

async function runInterceptor(code: string, command: string[], cwd: string, config: RetypeConfig): Promise<string> {
	if (command.length === 0 || !command[0]) throw new Error("Retype interceptor must contain a command");
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command[0], command.slice(1), {
			cwd,
			env: {
				...process.env,
				RETYPE_RULES: JSON.stringify(config.rules),
				RETYPE_RULE_MODE: config.ruleMode,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", rejectPromise);
		child.on("close", (exitCode) => {
			if (exitCode === 0) resolvePromise(stdout);
			else rejectPromise(new Error(`Retype interceptor exited ${exitCode}: ${stderr.trim()}`));
		});
		child.stdin.end(code);
	});
}

function appendLimited(current: string, chunk: Buffer, limit: number): string {
	if (Buffer.byteLength(current) >= limit) return current;
	const remaining = limit - Buffer.byteLength(current);
	return current + chunk.subarray(0, remaining).toString();
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") return record.text;
			if (record.type === "image") return "[image result]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function objectArgs(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("tool arguments must be a JSON object");
	}
	return value as Record<string, unknown>;
}

async function dispatch(
	pi: ExtensionAPI,
	name: string,
	args: unknown,
	ctx: ExtensionContext,
	job: Job,
	agentDir: string,
): Promise<BridgeResponse> {
	if (job.abort.signal.aborted) throw new Error("job cancelled");

	if (BUILTIN_NAMES.has(name)) {
		const mod = getBuiltins(ctx.cwd);
		const tool = mod[name];
		if (!tool) throw new Error(`Unknown Pi built-in tool ${name}`);
		const rawArgs = objectArgs(args);
		const preparedArgs = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
		const result = await tool.execute(
			`retype_${job.id}_${randomBytes(4).toString("hex")}`,
			preparedArgs,
			job.abort.signal,
		);
		return { ok: true, text: textFromContent(result.content), data: result.details };
	}

	return dispatchRegisteredTool(pi, name, args, ctx, job, agentDir);
}

type ToolEndEvent = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

async function dispatchRegisteredTool(
	pi: ExtensionAPI,
	name: string,
	args: unknown,
	ctx: ExtensionContext,
	job: Job,
	agentDir: string,
): Promise<BridgeResponse> {
	if (name === "retype" || name === "retype_job") throw new Error(`Retype cannot call itself through tool()`);
	const info = pi.getAllTools().find((tool) => tool.name === name);
	if (!info) throw new Error(`Unknown Pi tool ${name}`);

	const sourcePath = info.sourceInfo.path;
	const additionalExtensionPaths = sourcePath.startsWith("<") ? [] : [sourcePath];
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const faux = fauxProvider({ models: [{ id: "retype-tool-host", reasoning: false }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall(name, objectArgs(args)), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
	let abortNested: (() => void) | undefined;
	try {
		created = await createAgentSession({
			cwd: ctx.cwd,
			agentDir,
			model: faux.getModel(),
			modelRuntime,
			thinkingLevel: "off",
			tools: [name],
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.inMemory(ctx.cwd),
		});
		const capture: { event?: ToolEndEvent } = {};
		created.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === name) capture.event = event;
		});
		abortNested = () => created?.session.agent.abort();
		job.abort.signal.addEventListener("abort", abortNested, { once: true });
		if (job.abort.signal.aborted) throw new Error("job cancelled");
		await created.session.prompt(`Execute the ${name} tool call supplied by Retype.`);
		const event = capture.event;
		if (!event) throw new Error(`Pi did not execute registered tool ${name}`);
		const text = textFromContent(event.result.content);
		if (event.isError) throw new Error(text || `Pi tool ${name} failed`);
		return { ok: true, text, data: event.result.details };
	} finally {
		if (abortNested) job.abort.signal.removeEventListener("abort", abortNested);
		created?.session.dispose();
	}
}

type BuiltinTool = {
	prepareArguments?(args: unknown): Record<string, unknown>;
	execute(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: unknown; details?: unknown }>;
};

function getBuiltins(cwd: string): Record<string, BuiltinTool> {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};
}

async function readRequest(req: import("node:http").IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > 16 * 1024 * 1024) throw new Error("bridge request exceeds 16 MiB");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function startBridge(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	job: Job,
	agentDir: string,
): Promise<{ url: string; token: string }> {
	const token = randomBytes(24).toString("hex");
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		try {
			if (req.headers.authorization !== `Bearer ${token}`) throw new Error("unauthorized");
			if (req.method !== "POST") throw new Error("not found");
			const input = objectArgs(await readRequest(req));
			let result: unknown;
			if (req.url === "/call") {
				if (typeof input.name !== "string") throw new Error("missing tool name");
				result = await dispatch(pi, input.name, input.args, ctx, job, agentDir);
			} else if (req.url === "/tools") {
				const names = input.names;
				if (names !== undefined && (!Array.isArray(names) || names.some((name) => typeof name !== "string"))) {
					throw new Error("tool names must be an array of strings");
				}
				const selected = names === undefined ? undefined : new Set(names as string[]);
				result = {
					ok: true,
					tools: pi
						.getAllTools()
						.filter((info) => info.name !== "retype" && info.name !== "retype_job" && (!selected || selected.has(info.name)))
						.map((info) => ({ name: info.name, description: info.description, parameters: info.parameters })),
				};
			} else {
				throw new Error("not found");
			}
			res.statusCode = 200;
			res.end(JSON.stringify(result));
		} catch (error) {
			res.statusCode = 400;
			res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
		}
	});
	job.server = server;
	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", rejectPromise);
			resolvePromise();
		});
	});
	const address = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${address.port}`, token };
}

function stopProcess(job: Job): void {
	job.abort.abort();
	job.server?.close();
	if (job.child && job.child.exitCode === null) {
		job.child.kill("SIGTERM");
		setTimeout(() => {
			if (job.child && job.child.exitCode === null) job.child.kill("SIGKILL");
		}, 2_000).unref();
	}
}

function closeStream(stream: WriteStream): Promise<void> {
	return new Promise((resolvePromise) => stream.end(resolvePromise));
}

export class RetypeRunner {
	private readonly jobs = new Map<string, Job>();
	private readonly pi: ExtensionAPI;
	private readonly agentDir: string;

	constructor(pi: ExtensionAPI, agentDir: string) {
		this.pi = pi;
		this.agentDir = agentDir;
	}

	list(): JobSnapshot[] {
		return Array.from(this.jobs.values())
			.map(({ abort: _abort, child: _child, server: _server, ...snapshot }) => snapshot)
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	}

	get(id: string): JobSnapshot | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		const { abort: _abort, child: _child, server: _server, ...snapshot } = job;
		return snapshot;
	}

	cancel(id: string): JobSnapshot {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown Retype job ${id}`);
		if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return this.get(id) as JobSnapshot;
		job.status = "cancelled";
		job.finishedAt = new Date().toISOString();
		stopProcess(job);
		return this.get(id) as JobSnapshot;
	}

	shutdown(): void {
		for (const job of this.jobs.values()) {
			if (job.status === "running") {
				job.status = "cancelled";
				job.finishedAt = new Date().toISOString();
				stopProcess(job);
				job.server?.close();
			}
		}
	}

	async run(code: string, timeoutMs: number | undefined, ctx: ExtensionContext, outerSignal?: AbortSignal): Promise<JobSnapshot> {
		const config = await loadConfig(ctx.cwd, this.agentDir);
		let effectiveCode = applyRules(code, config);
		if (config.interceptor) effectiveCode = await runInterceptor(effectiveCode, config.interceptor, ctx.cwd, config);

		const digest = createHash("sha256").update(effectiveCode).digest("hex").slice(0, 8);
		const id = `${Date.now().toString(36)}-${digest}-${randomBytes(3).toString("hex")}`;
		const runDir = join(this.agentDir, "retype", "runs", id);
		await mkdir(runDir, { recursive: true });
		const mainPath = join(runDir, "action.mts");
		const runtimePath = join(runDir, "retype_runtime.mjs");
		const actionResultPath = join(runDir, "action-result.json");
		const runtimeSource = await readFile(RUNTIME_PATH, "utf8");
		const program = `import { writeFile as __retypeWriteFile } from "node:fs/promises";\nimport { describeTools, tool, tools } from "./retype_runtime.mjs";\n\nconst __retypeMain = async () => {\n${effectiveCode}\n};\n\nconst __retypeValue = await __retypeMain();\nawait __retypeWriteFile(new URL("./action-result.json", import.meta.url), JSON.stringify(__retypeValue ?? null), "utf8");\n`;
		await Promise.all([writeFile(mainPath, program, "utf8"), writeFile(runtimePath, runtimeSource, "utf8")]);

		const job: Job = {
			id,
			status: "running",
			startedAt: new Date().toISOString(),
			background: false,
			runDir,
			abort: new AbortController(),
		};
		this.jobs.set(id, job);

		const onOuterAbort = () => stopProcess(job);
		if (outerSignal) {
			if (outerSignal.aborted) onOuterAbort();
			else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
		}

		const bridge = await startBridge(this.pi, ctx, job, this.agentDir);
		const stdoutFile = createWriteStream(join(runDir, "stdout.log"));
		const stderrFile = createWriteStream(join(runDir, "stderr.log"));
		const child = spawn(process.execPath, [mainPath], {
			cwd: ctx.cwd,
			env: {
				...process.env,
				RETYPE_BRIDGE_URL: bridge.url,
				RETYPE_BRIDGE_TOKEN: bridge.token,
				RETYPE_CALL_TIMEOUT_MS: String(config.bridgeTimeoutMs),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		job.child = child;
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutFile.write(chunk);
			stdout = appendLimited(stdout, chunk, config.maxOutputBytes);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrFile.write(chunk);
			stderr = appendLimited(stderr, chunk, config.maxOutputBytes);
		});

		const completion = new Promise<JobSnapshot>((resolvePromise) => {
			child.on("error", (error) => {
				stderr += error.message;
			});
			child.on("close", async (exitCode) => {
				await Promise.all([closeStream(stdoutFile), closeStream(stderrFile)]);
				job.server?.close();
				job.exitCode = exitCode;
				job.finishedAt = new Date().toISOString();
				job.stdout = stdout.trim();
				job.stderr = stderr.trim();
				let actionResult: Buffer | undefined;
				try {
					actionResult = await readFile(actionResultPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						job.stderr = [job.stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join("\n");
					}
				}
				if (actionResult) {
					job.resultBytes = actionResult.length;
					job.resultTruncated = actionResult.length > config.maxOutputBytes;
					job.result = actionResult.subarray(0, config.maxOutputBytes).toString("utf8");
				}
				if (job.status !== "cancelled") job.status = exitCode === 0 && actionResult ? "completed" : "failed";
				if (job.status === "failed" && !job.error) {
					job.error = job.stderr || job.stdout || (!actionResult ? "TypeScript action returned no result" : `program exited ${exitCode}`);
				}
				if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
				await writeFile(join(runDir, "result.json"), JSON.stringify(this.get(id), null, 2), "utf8");
				resolvePromise(this.get(id) as JobSnapshot);
			});
		});

		const foregroundMs = timeoutMs && timeoutMs > 0 ? Math.floor(timeoutMs) : config.foregroundMs;
		let foregroundTimer: NodeJS.Timeout | undefined;
		const winner = await Promise.race([
			completion.then((snapshot) => ({ type: "done" as const, snapshot })),
			new Promise<{ type: "timeout" }>((resolvePromise) =>
				(foregroundTimer = setTimeout(() => resolvePromise({ type: "timeout" }), foregroundMs)),
			),
		]);
		if (winner.type === "done") {
			if (foregroundTimer) clearTimeout(foregroundTimer);
			return winner.snapshot;
		}

		job.background = true;
		if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
		completion.then((snapshot) => {
			try {
				this.pi.sendMessage(
					{
						customType: "retype-job",
						content: `Retype job ${snapshot.id} ${snapshot.status}. Use retype_job to inspect it.`,
						display: true,
						details: snapshot,
					},
					{ triggerTurn: false },
				);
			} catch {
				// The Pi session may have closed while a background job was finishing.
			}
		});
		return this.get(id) as JobSnapshot;
	}
}
