import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, RetypeRunner, applyRules, loadConfig } from "../extensions/runtime.ts";

const CUSTOM_TOOL_PATH = fileURLToPath(new URL("./custom-tool.ts", import.meta.url));

function testPi(activeTools: string[], customToolPath?: string): ExtensionAPI {
	return {
		getActiveTools: () => activeTools,
		getAllTools: () =>
			customToolPath
				? [
						{
							name: "custom_echo",
							description: "Echo a value through a user-registered Pi tool.",
							parameters: {},
							sourceInfo: {
								path: customToolPath,
								source: customToolPath,
								scope: "temporary",
								origin: "top-level",
							},
						},
					]
				: [],
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
}

async function waitForDone(runner: RetypeRunner, id: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const status = runner.get(id)?.status;
		if (status === "completed" || status === "failed" || status === "cancelled") return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	throw new Error(`Timed out waiting for ${id}`);
}

test("comment rules rewrite matching TypeScript lines", () => {
	const code = 'await bash("rm -rf /");';
	const result = applyRules(code, { ...DEFAULT_CONFIG, rules: ["rm -rf"] });
	assert.match(result, /\/\/ retype blocked "rm -rf": await bash/);
});

test("reject rules stop matching code", () => {
	assert.throws(
		() => applyRules("return await read(path);", { ...DEFAULT_CONFIG, rules: ["read(path)"], ruleMode: "reject" }),
		/read\(path\)/,
	);
});

test("project config overrides user config", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-retype-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await Promise.all([mkdir(agentDir), mkdir(join(cwd, ".pi"), { recursive: true })]);
	await writeFile(join(agentDir, "retype.json"), JSON.stringify({ foregroundMs: 1000, rules: ["global"] }));
	await writeFile(join(cwd, ".pi", "retype.json"), JSON.stringify({ foregroundMs: 2000 }));
	const config = await loadConfig(cwd, agentDir);
	assert.equal(config.foregroundMs, 2000);
	assert.deepEqual(config.rules, ["global"]);
});

test("TypeScript action calls multiple real Pi built-in tools", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-retype-integration-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	await Promise.all([
		writeFile(join(cwd, "input.txt"), "from-read\n"),
		writeFile(join(cwd, "input.log"), "from-log\n"),
	]);
	const runner = new RetypeRunner(testPi(["retype", "retype_job"]), agentDir);
	const code = [
		"const values = await Promise.all([",
		'  tools.read({ path: "input.txt" }),',
		'  tools.bash({ command: "printf from-bash" }),',
		'  tools.grep({ pattern: "from", path: ".", glob: "*.txt" }),',
		"]);",
		"return { read: values[0].text.trim(), bash: values[1].text.trim(), grep: values[2].text.trim() };",
	].join("\n");
	const result = await runner.run(code, 10_000, { cwd } as ExtensionContext);
	assert.equal(result.status, "completed", result.error ?? result.stderr);
	assert.deepEqual(JSON.parse(result.result ?? ""), {
		read: "from-read",
		bash: "from-bash",
		grep: "input.txt:1: from-read",
	});
});

test("Pi built-ins remain available behind the Retype-only model boundary", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-retype-inactive-tool-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	await writeFile(join(cwd, "input.txt"), "hidden-tool\n");
	const runner = new RetypeRunner(testPi(["retype", "retype_job"]), agentDir);
	const result = await runner.run('return await tools.read({ path: "input.txt" });', 10_000, { cwd } as ExtensionContext);
	assert.equal(result.status, "completed", result.error ?? result.stderr);
	assert.equal(JSON.parse(result.result ?? "").text.trim(), "hidden-tool");
});

test("user-registered Pi tools are discovered and executed through the official SDK", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-retype-custom-tool-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	const runner = new RetypeRunner(testPi(["retype", "retype_job"], CUSTOM_TOOL_PATH), agentDir);
	const result = await runner.run(
		'const [catalog, value] = await Promise.all([describeTools(["custom_echo"]), tools.custom_echo({ value: "hello" })]); return { catalog, value };',
		10_000,
		{ cwd } as ExtensionContext,
	);
	assert.equal(result.status, "completed", result.error ?? result.stderr);
	const output = JSON.parse(result.result ?? "") as {
		catalog: Array<{ name: string; description: string }>;
		value: { text: string; data: { cwd: string } };
	};
	assert.deepEqual(output.catalog.map((tool) => tool.name), ["custom_echo"]);
	assert.equal(output.value.text, "hello:hooked");
	assert.equal(output.value.data.cwd, cwd);
});

test("long TypeScript action is promoted to a background job", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-retype-background-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	const runner = new RetypeRunner(testPi([]), agentDir);
	const code = 'await new Promise((resolve) => setTimeout(resolve, 80)); return "done";';
	const initial = await runner.run(code, 5, { cwd } as ExtensionContext);
	assert.equal(initial.background, true);
	assert.equal(initial.status, "running");
	await waitForDone(runner, initial.id);
	const completed = runner.get(initial.id);
	assert.equal(completed?.status, "completed", completed?.error ?? completed?.stderr);
	assert.equal(completed?.result, '"done"');
});

test("large results are explicitly truncated while the full action result stays on disk", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-retype-result-limit-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	await writeFile(join(agentDir, "retype.json"), JSON.stringify({ maxOutputBytes: 32 }));
	const runner = new RetypeRunner(testPi([]), agentDir);
	const result = await runner.run('return { value: "x".repeat(100) };', 10_000, { cwd } as ExtensionContext);
	assert.equal(result.status, "completed", result.error ?? result.stderr);
	assert.equal(result.resultTruncated, true);
	assert.equal(result.result?.length, 32);
	assert.equal(result.resultBytes, 112);
	const full = JSON.parse(await readFile(join(result.runDir, "action-result.json"), "utf8")) as { value: string };
	assert.equal(full.value.length, 100);
});
