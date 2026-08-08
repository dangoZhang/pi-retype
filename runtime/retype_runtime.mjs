const bridgeUrl = process.env.RETYPE_BRIDGE_URL;
const bridgeToken = process.env.RETYPE_BRIDGE_TOKEN;
const callTimeoutMs = Number(process.env.RETYPE_CALL_TIMEOUT_MS) || 300_000;

export async function tool(name, args) {
	const response = await fetch(`${bridgeUrl}/call`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${bridgeToken}`,
		},
		body: JSON.stringify({ name, args }),
		signal: AbortSignal.timeout(callTimeoutMs),
	});
	const result = await response.json();
	if (!result.ok) throw new Error(`${name}: ${result.error ?? `HTTP ${response.status}`}`);
	return { text: result.text ?? "", data: result.data };
}

export async function describeTools(names) {
	const response = await fetch(`${bridgeUrl}/tools`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${bridgeToken}`,
		},
		body: JSON.stringify({ ...(names ? { names } : {}) }),
		signal: AbortSignal.timeout(callTimeoutMs),
	});
	const result = await response.json();
	if (!result.ok) throw new Error(`describeTools: ${result.error ?? `HTTP ${response.status}`}`);
	return result.tools;
}

export const tools = new Proxy(Object.create(null), {
	get(_target, name) {
		if (typeof name !== "string") return undefined;
		return (args = {}) => tool(name, args);
	},
});
