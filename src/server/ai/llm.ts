// src/server/ai/llm.ts
//
// LOLDATA AI — Claude tool-use agent loop. Claude reads the user's question,
// decides which data tool(s) to call (champion stats, item rankings against a
// given enemy comp, duos, matchups, the user's own recent form), we run those
// tools against the box, feed the results back, and Claude writes a concise
// grounded answer. Pure agentic loop: the model drives the trajectory.

import Anthropic from "@anthropic-ai/sdk";

// ── Model — the one line to change ──────────────────────────────────────────
// Opus 4.8 gives the most reliable autonomous tool-routing + answer quality.
// For a higher-volume / lower-latency public chat, switch to "claude-sonnet-4-6"
// (~3× cheaper, noticeably snappier) — nothing else needs to change.
export const AI_MODEL = "claude-opus-4-8";

// Lazy client — constructing it at module load with a missing key throws in the
// SDK and would crash the whole backend at boot. Built on first use instead; the
// route's `ANTHROPIC_API_KEY` guard short-circuits before we ever get here.
let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  return _client;
}

export type ToolExecutor = (name: string, input: any) => Promise<unknown>;

/**
 * Run the agentic tool-use loop until Claude returns a final text answer (or we
 * hit the turn cap). Tools are executed by `onToolCall`; their JSON results are
 * fed straight back to the model. No `temperature`/`thinking` params — the 4.x
 * family rejects `temperature`, and we keep thinking off for chat latency.
 */
export async function runAgent(
  system: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  onToolCall: ToolExecutor,
  { maxTurns = 6 }: { maxTurns?: number } = {}
): Promise<string> {
  const convo: Anthropic.MessageParam[] = [...messages];

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await client().messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      system,
      messages: convo,
      tools,
    });

    const textParts: string[] = [];
    const toolUses: { id: string; name: string; input: any }[] = [];
    for (const block of res.content) {
      if (block.type === "text") textParts.push(block.text);
      else if (block.type === "tool_use")
        toolUses.push({ id: block.id, name: block.name, input: block.input });
    }

    // No tool calls → this is the final answer.
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      return textParts.join("").trim();
    }

    // Echo the assistant turn (with its tool_use blocks) verbatim, then answer
    // each tool call with a tool_result block.
    convo.push({ role: "assistant", content: res.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      try {
        const result = await onToolCall(tu.name, tu.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      } catch (err: any) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Error: ${err?.message ?? String(err)}`,
          is_error: true,
        });
      }
    }
    convo.push({ role: "user", content: toolResults });
  }

  return "I couldn't finish analysing that — try narrowing the question (a specific champion, role, or matchup).";
}
