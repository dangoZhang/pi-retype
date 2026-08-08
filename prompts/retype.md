<retype>
All tool use MUST happen inside `retype` TypeScript actions. Never call read, bash, edit, write, grep, find, ls, or a registered Pi tool directly. `retype_job` is only for inspecting or cancelling a background Retype action.

Treat each Retype call as one bounded stage between model decisions. Put every call whose arguments and control flow are already knowable into that stage. End it where fresh semantic judgment is needed, inspect the compact result, then write the next Retype stage. A stage may explore, edit, validate, or combine all three.

Score a candidate stage to decide how much work to include:

- +2: later arguments can be derived mechanically from earlier results.
- +2: code can discard at least half of the intermediate output.
- +2: the stage needs a loop, branch, aggregation, pagination, or bounded retry.
- +1: at least three concrete tool calls are already known.
- +1: independent calls can run concurrently.

Aim for score 2 or higher. A single internal tool call is allowed when the result requires immediate model judgment. Target 2–8 calls per stage; do not exceed 12 unless iterating one homogeneous, bounded operation.

## Program

Write only the body of one async TypeScript function. Do not add imports, exports, a wrapper, Markdown fences, or local variables named `tool`, `tools`, or `describeTools`. Keep it focused and ordinarily below 60 lines.

```ts
type ToolResult = { text: string; data?: unknown };
type ToolInfo = { name: string; description: string; parameters: unknown };

tool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
tools[name](args: Record<string, unknown>): Promise<ToolResult>;
describeTools(names?: string[]): Promise<ToolInfo[]>;
```

Every tool call returns `ToolResult`; textual output is always `.text`. Use `tools.read({...})` for identifier-like names and `tools["custom-name"]({...})` otherwise. `tools` automatically covers Pi's official tools and every configured tool registered by an extension. If an unfamiliar registered tool is needed, call `describeTools([name])` in one stage and use its exact schema in the next.

Official Pi built-ins keep their schemas:

```ts
tools.read({ path, offset?, limit? })
tools.bash({ command, timeout? })
tools.edit({ path, edits: [{ oldText, newText }] })
tools.write({ path, content })
tools.grep({ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? })
tools.find({ pattern, path?, limit? })
tools.ls({ path?, limit? })
```

## Uncertainty and errors

Discover paths from known roots such as `.` with grep, find, or ls; do not guess narrow paths. Use `Promise.all` only when every call is expected to succeed. Use `Promise.allSettled` for optional probes, preserve concise error messages, and continue with successful results. Let a required-call failure throw. Never hide failures or invent evidence. Retry only known transient failures, at most once.

Edits should be small and evidence-based. Keep approval-sensitive operations in their own stage. After editing, use a later Retype stage for focused tests and a compact diff/status check.

## Return

Return one JSON-serializable value and do not print it. Return evidence and derived facts, not narration. Prefer `{ path, line, snippet }` records, small counts, selected identifiers, changed files, test summaries, and a short `errors` array. Use TypeScript to split, slice, match, map, filter, and reduce before returning.

Keep the result below 30 lines, 3000 characters, and 10 evidence items. Never return whole files or full logs. If useful results cannot fit, return a compact index and inspect the next slice in another stage. Set `timeout_ms` to a realistic foreground estimate; execution becomes a background job after that estimate without being killed.

## Mixed multi-step example

```ts
const hits = await tools.grep({
  pattern: "serialize",
  path: ".",
  glob: "*.ts",
  limit: 30,
});

const paths = [...new Set(
  hits.text.split("\n")
    .map(line => line.match(/^(.+?):\d+:/)?.[1])
    .filter(Boolean),
)].slice(0, 6);

const settled = await Promise.allSettled(
  paths.map(path => tools.read({ path, limit: 240 })),
);

const evidence = [];
const errors = [];
for (let i = 0; i < settled.length; i++) {
  const item = settled[i];
  if (item.status === "rejected") {
    errors.push({ path: paths[i], error: String(item.reason).slice(0, 200) });
    continue;
  }
  const snippets = item.value.text.split("\n")
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(row => row.text.includes("serialize"))
    .slice(0, 3);
  evidence.push({ path: paths[i], snippets });
}

return { evidence: evidence.slice(0, 6), errors: errors.slice(0, 4) };
```
</retype>
