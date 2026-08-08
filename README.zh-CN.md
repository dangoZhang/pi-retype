<h1 align="center">Retype</h1>

<p align="center"><strong>由 TypeScript 驱动的 Pi 程序化工具调用编排。</strong></p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/dangoZhang/pi-retype/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/dangoZhang/pi-retype/ci.yml?style=flat-square&label=tests"></a>
  <a href="https://www.npmjs.com/package/pi-retype"><img alt="npm" src="https://img.shields.io/npm/v/pi-retype?style=flat-square"></a>
  <a href="https://pi.dev/packages/pi-retype"><img alt="Pi Package Catalog" src="https://img.shields.io/badge/Pi-Package_Catalog-5E5CE6?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/github/license/dangoZhang/pi-retype?style=flat-square"></a>
</p>

Retype 为 [Pi](https://github.com/earendil-works/pi) 提供一个程序化工具网关。模型编写 async TypeScript，调用当前 Pi 工具、处理中间数据，只返回紧凑结果。并行读取、循环、分支、重试和筛选都无需额外模型往返。在评测中，Retype 以相同通过数减少了 28.0% provider token 和 16.4% agent 运行时间。

```text
Pi：      模型 → 工具 → 模型 → 工具 → 模型 → 工具 → 模型
Retype：  模型 → TypeScript stage → 隐藏的 Pi 工具 → 紧凑结果 → 模型
```

核心只有一个 Pi extension 和一个零依赖 runtime 文件。Node.js 直接执行可擦除类型的 TypeScript，无需编译器、语言 SDK、adapter registry 或项目初始化。

## 安装

Retype 需要 Pi 0.84.1+ 和 Node.js 22.18+。

```bash
pi install npm:pi-retype
```

重启 Pi 或运行 `/reload`。Retype 会自动成为模型的工具网关，无需配置。

也可以固定版本或直接安装源码：

```bash
pi install npm:pi-retype@0.3.0
pi install git:github.com/dangoZhang/pi-retype@v0.3.0
```

## TypeScript 行动接口

`retype` 工具接收一个 async TypeScript 函数体。一个 stage 可以分支、循环、重试、聚合和并发执行独立调用：

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

Retype 只返回序列化结果。模型可用接口保持精简：

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

这些函数对应 Pi 的七个官方 tool schema，包括 `grep.glob`，并保留工作目录和取消信号。Retype stage 应在需要模型重新判断的位置结束；下一 stage 可以从紧凑结果继续。模型在整个 session 中都不能直接调用 Pi 工具。

## 自动接入扩展工具

`tools[name](args)` 和 `tool(name, args)` 自动暴露已配置 Pi extension 注册的工具，`describeTools()` 返回真实 schema。Retype 通过本地无网络 faux provider 驱动的临时 Pi 官方 SDK session 执行注册工具，保留 Pi 的校验、hooks、`ExtensionContext` 和取消流程；官方内置工具直接使用 Pi tool factory。

无需编写 Retype adapter。安装包、项目 extension 或显式 extension 文件只要注册普通 Pi 工具，TypeScript 就能调用。MCP、Skill 和 Subagent 在对应 Pi extension 将其暴露为工具时自动接入。依赖交互式 UI 的工具可能在 headless tool host 中主动拒绝执行。

## Prompt

[`prompts/retype.md`](prompts/retype.md) 是开箱即用的默认指令，包含 stage 大小、工具 schema、探索策略、错误处理、输出限制及混合多步示例。无需重新构建即可覆盖：

- 项目：`.pi/retype.md`
- 用户：`~/.pi/agent/retype.md`

项目 Prompt 优先。欢迎在 [`prompts/community/`](prompts/community/) 贡献模型专用 Prompt。

## 策略与限制

项目配置放在 `.pi/retype.json`，用户默认配置放在 `~/.pi/agent/retype.json`。

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

规则可以注释命中代码、拒绝行动或关闭。可选 interceptor 从 stdin 接收过滤后的 TypeScript 源码，让策略始终由用户维护和替换。

模型通过 `timeout_ms` 提供前台时间预估。到期后 Retype 返回 job id，并让进程继续运行。使用 `retype_job` 或 `/retype [id|cancel id]` 查看和取消。有效源码、runtime、日志及完整结果保存在 `~/.pi/agent/retype/runs/<job-id>/`。

## 安全边界

> [!WARNING]
> Retype 生成的 TypeScript 与 Pi 拥有相同的操作系统权限。Retype 不是 sandbox。

请在可信项目中使用；需要更强隔离时，把 Pi 放入容器。自定义规则属于 guardrail，不能替代安全边界。隔离方式参见 Pi 的[容器化文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)。

## 真实评测

我们选择了 [`swe-bench-verified-mini`](https://huggingface.co/datasets/MariusHobbhahn/swe-bench-verified-mini) 中 35 个双方均未超时的配对任务，再使用 SWE-bench 官方 harness 评测每份 patch。

| 指标 | 原生 Pi | Pi + Retype | 变化 |
|---|---:|---:|---:|
| 通过 | 30/35 | 30/35 | 持平 |
| Provider tokens | 41.19M | 29.65M | -28.0% |
| 模型调用 | 1,220 | 1,096 | -10.2% |
| Agent 累计运行时间 | 2h 01m 54s | 1h 41m 54s | -16.4% |

其中一个双方都通过的任务，模型调用从 53 次降至 19 次，token 从 1.41M 降至 218.6K。下面是该题真实生成的 TypeScript stage：

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

方法：Pi 0.84.1、`deepseek/deepseek-v4-flash`、thinking `high`、相同 issue Prompt 与独立干净 worktree、paired 交替顺序、8 路并发生成、单次 900 秒限制，以及 8 个官方测试 worker。Retype 使用发布包中的 [`prompts/retype.md`](prompts/retype.md)；题目日志和生成 patch 不进入仓库。

## 贡献

保持核心小、只依赖 Pi 公开 API、让策略可替换。修改 Prompt 时，建议同时提供质量和 token 证据。

```bash
npm install --ignore-scripts
npm run check
npm test
```

## 协议

[MIT](LICENSE) © Retype contributors
