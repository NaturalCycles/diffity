/** What the gate makes of one PreToolUse payload: a refusal carries the line the agent is shown. */
export type GateDecision =
  | { allow: true }
  | { allow: false; message: string };

/**
 * Whether the review agent may make this tool call. Built-in tools are none of the gate's business
 * — the deny list and permissions cover those — so only `mcp__` names are judged, against the exact
 * names the reviewer allowlisted. Anything the gate cannot read is refused: a payload it does not
 * understand is not evidence that the call is safe.
 */
export function mcpGateDecision(input: unknown, allow: string[]): GateDecision {
  const toolName = toolNameOf(input);
  if (toolName === null) {
    return { allow: false, message: `${onlyThese(allow)}; the tool call could not be read` };
  }
  if (!toolName.startsWith('mcp__') || allow.includes(toolName)) {
    return { allow: true };
  }
  return { allow: false, message: `${onlyThese(allow)}; ${toolName} is not allowed` };
}

function toolNameOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const name = (input as { tool_name?: unknown }).tool_name;
  return typeof name === 'string' && name !== '' ? name : null;
}

function onlyThese(allow: string[]): string {
  return `the review agent may only use ${allow.length > 0 ? allow.join(', ') : 'no MCP tools'}`;
}

/** The allowlist as `agentEnv` hands it to the agent, and so to this hook. */
export function allowFromEnv(value: string | undefined): string[] {
  return (value ?? '').split(',').map(name => name.trim()).filter(Boolean);
}
