<h1 align="center">Retype</h1>

<p align="center"><strong>Programmatic tool calling orchestration for Pi powered by TypeScript.</strong></p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/dangoZhang/pi-retype/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/dangoZhang/pi-retype/ci.yml?style=flat-square&label=tests"></a>
  <a href="https://www.npmjs.com/package/pi-retype"><img alt="npm" src="https://img.shields.io/npm/v/pi-retype?style=flat-square"></a>
  <a href="https://pi.dev/packages/pi-retype"><img alt="Pi Package Catalog" src="https://img.shields.io/badge/Pi-Package_Catalog-5E5CE6?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/github/license/dangoZhang/pi-retype?style=flat-square"></a>
</p>

Retype gives [Pi](https://github.com/earendil-works/pi) one programmatic gateway. The model writes async TypeScript that can call active Pi tools, process intermediate data, and return one compact result. Parallel reads, loops, branches, retries, and filtering happen without another model round trip. In benchmark, Retype used 28.0% fewer provider tokens and 16.4% less agent time at the same resolved score.

```text
Pi:      model → tool → model → tool → model → tool → model
Retype:  model → TypeScript stage → hidden Pi tools → compact result → model
```

The core is one Pi extension and one dependency-free runtime file. Node.js executes erasable TypeScript directly, so there is no compiler, language SDK, adapter registry, or project setup.

## Install

Retype requires Pi 0.84.1+ and Node.js 22.18+.

```bash
pi install npm:pi-retype
```

Restart Pi or run `/reload`. Retype becomes the model's tool gateway automatically; no configuration is required.

Pinned installs are also supported:

```bash
pi install npm:pi-retype@0.3.0
pi install git:github.com/dangoZhang/pi-retype@v0.3.0
```

## TypeScript action API

The `retype` tool accepts the body of one async TypeScript function. A stage can branch, loop, retry, aggregate, and run independent calls concurrently:

```ts
const [readme, status] = await Promise.all([
  tools.read({ path: "README.md" }),
  tools.bash({ command: "git status --short" }),
]);

return {
  readmeBytes: readme.text.length,
  gitStatus: status.text.trim(),
};
```

Retype returns only the serialized value. Its model-facing API stays small:

```ts
type ToolResult = { text: string; data?: unknown };
type ToolInfo = { name: string; description: string; parameters: unknown };

tool(name: string, args: Record<string, unknown>): Promise<ToolResult>
describeTools(names?: string[]): Promise<ToolInfo[]>
tools.read({ path, offset?, limit? }): Promise<ToolResult>
tools.bash({ command, timeout? }): Promise<ToolResult>
tools.edit({ path, edits }): Promise<ToolResult>
tools.write({ path, content }): Promise<ToolResult>
tools.grep({ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }): Promise<ToolResult>
tools.find({ pattern, path?, limit? }): Promise<ToolResult>
tools.ls({ path?, limit? }): Promise<ToolResult>
tools[name](args): Promise<ToolResult>
```

These functions mirror Pi's seven official tool schemas, including `grep.glob`, and preserve the working directory and cancellation signal. A Retype call should end where fresh model judgment is needed; the next stage can continue from its compact result. Direct Pi tool calls remain blocked throughout the session.

## Automatic extension tools

`tools[name](args)` and `tool(name, args)` automatically expose tools registered by configured Pi extensions. `describeTools()` returns their real schemas. Retype executes a registered tool through a temporary official Pi SDK session with a local no-network faux provider, preserving Pi's validation, hooks, `ExtensionContext`, and cancellation. Official built-ins use Pi's tool factories directly.

There is no Retype adapter to write. An installed package, project extension, or explicit extension file that registers an ordinary Pi tool becomes callable from TypeScript. MCP, skills, and subagents are covered when their Pi extension exposes them as tools. Tools that require an interactive UI may decline in the headless tool host.

## Prompt

[`prompts/retype.md`](prompts/retype.md) is the shipped default. It defines stage size, tool schemas, exploration, error handling, output limits, and a mixed multi-step example. Override it without rebuilding:

- project: `.pi/retype.md`
- user: `~/.pi/agent/retype.md`

The project prompt wins. Model-specific prompt contributions are welcome under [`prompts/community/`](prompts/community/).

## Policy and limits

Optional project settings live at `.pi/retype.json`; user defaults live at `~/.pi/agent/retype.json`.

```json
{
  "foregroundMs": 15000,
  "bridgeTimeoutMs": 300000,
  "maxOutputBytes": 4096,
  "rules": ["rm -rf", "process.exit"],
  "ruleMode": "comment",
  "interceptor": ["node", "./scripts/retype-filter.mjs"]
}
```

Rules can comment matching source lines, reject the action, or be disabled. An optional interceptor receives the filtered TypeScript source on stdin, so policy stays user-owned and replaceable.

The model supplies a foreground estimate as `timeout_ms`. When that time elapses, Retype returns a job id and lets the process continue. Inspect or cancel it with `retype_job` or `/retype [id|cancel id]`. Effective code, runtime, logs, and the full result stay under `~/.pi/agent/retype/runs/<job-id>/`.

## Security

> [!WARNING]
> Retype runs model-generated TypeScript with the same OS permissions as Pi. It is not a sandbox.

Use trusted projects or run Pi inside a container when stronger isolation is required. Rules are customizable guardrails, not a security boundary. See Pi's [containerization guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md).

## Benchmark

We selected 35 paired [`swe-bench-verified-mini`](https://huggingface.co/datasets/MariusHobbhahn/swe-bench-verified-mini) tasks where neither run timed out. Every patch was graded with the official SWE-bench harness.

| Metric | Native Pi | Pi + Retype | Change |
|---|---:|---:|---:|
| Resolved | 30/35 | 30/35 | equal |
| Provider tokens | 41.19M | 29.65M | -28.0% |
| Model calls | 1,220 | 1,096 | -10.2% |
| Summed agent time | 2h 01m 54s | 1h 41m 54s | -16.4% |

One task passed in both variants while dropping from 53 to 19 model calls and from 1.41M to 218.6K tokens. This is an exact TypeScript stage generated during that run:

```ts
const lsTests = await tools.ls({ path: "tests/model_choices" });
const grepEnum = await tools.grep({
  pattern: "do_not_call_in_templates|template",
  path: "tests/model_choices",
  limit: 20,
});
const bash = await tools.bash({
  command: "python -c \"import enum; class Color(enum.Enum): RED=1; print(callable(Color)); print(callable(Color.RED))\"",
  timeout: 30000,
});
return { lsTests: lsTests.text, grepEnum: grepEnum.text, bash: bash.text };
```

Method: Pi 0.84.1, `deepseek/deepseek-v4-flash`, thinking `high`, identical issue prompts and clean worktrees, paired alternating order, eight concurrent generations, a 900-second limit, and eight official test workers. Retype used the shipped [`prompts/retype.md`](prompts/retype.md); task logs and generated patches are excluded.

## Contributing

Keep the core small, depend only on public Pi APIs, and keep policy replaceable. Prompt changes should include quality and token evidence when practical.

```bash
npm install --ignore-scripts
npm run check
npm test
```

## License

[MIT](LICENSE) © Retype contributors
