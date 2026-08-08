import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function customToolExtension(pi: ExtensionAPI) {
	pi.on("tool_result", (event) => {
		if (event.toolName !== "custom_echo") return;
		const text = event.content.find((part) => part.type === "text")?.text ?? "";
		return { content: [{ type: "text", text: `${text}:hooked` }] };
	});

	pi.registerTool({
		name: "custom_echo",
		label: "Custom echo",
		description: "Echo a value through a user-registered Pi tool.",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return {
				content: [{ type: "text", text: params.value }],
				details: { cwd: ctx.cwd },
			};
		},
	});
}
