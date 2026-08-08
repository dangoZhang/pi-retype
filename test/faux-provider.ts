import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const defaultCode = [
	"const [readme, shell] = await Promise.all([",
	'  tools.read({ path: "README.md" }),',
	'  tools.bash({ command: "printf cli-bridge-ok" }),',
	"]);",
	'return { readNonempty: readme.text.trim() !== "", bash: shell.text.trim() };',
].join("\n");

const code = process.env.RETYPE_TEST_CODE ?? defaultCode;

export default function fauxProviderExtension(pi: ExtensionAPI) {
	const expectedPrompt = process.env.RETYPE_EXPECT_PROMPT;
	if (expectedPrompt) {
		pi.on("before_provider_request", (event) => {
			if (!JSON.stringify(event.payload).includes(expectedPrompt)) {
				throw new Error(`Retype system prompt is missing ${JSON.stringify(expectedPrompt)}`);
			}
		});
	}
	if (process.env.RETYPE_EXPECT_GATEWAY === "1") {
		pi.on("before_provider_request", (event) => {
			const payload = event.payload as { tools?: Array<{ name?: string; function?: { name?: string } }> };
			const names = (payload.tools ?? []).map((entry) => entry.function?.name ?? entry.name).filter(Boolean);
			if (names.some((name) => name !== "retype" && name !== "retype_job")) {
				throw new Error(`Direct tool leaked through Retype gateway: ${names.join(", ")}`);
			}
			if (!names.includes("retype")) throw new Error(`Retype tool missing from provider payload: ${names.join(", ")}`);
		});
	}
	const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("retype", { code, timeout_ms: 10_000 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("pi-retype-cli-integration-ok"),
	]);
	const model = faux.getModel();
	pi.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
		})),
	});
}
