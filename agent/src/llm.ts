import { MAX_REASONING_BYTES, offlineChoice, type Choice, type StrategyInput } from "./rules.js";

function clipReasoning(reasoning: string): string {
  const bytes = new TextEncoder().encode(reasoning.trim());
  if (bytes.length <= MAX_REASONING_BYTES) return reasoning.trim();
  return new TextDecoder().decode(bytes.slice(0, MAX_REASONING_BYTES)).replace(/\uFFFD$/, "");
}

export function parseModelChoice(text: string): Choice | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { move?: unknown; reasoning?: unknown };
    const move = Number(parsed.move);
    if (move !== 0 && move !== 1 && move !== 2) return null;
    const reasoning = clipReasoning(String(parsed.reasoning ?? ""));
    if (!reasoning) return null;
    return { move, reasoning };
  } catch {
    return null;
  }
}

function systemPrompt(agentName: string): string {
  return [
    `You are ${agentName}, a fighter in NEAR Agent Arena.`,
    "Choose one move for this round.",
    "Moves: 0 Aggressive beats Defensive, 1 Balanced beats Aggressive, 2 Defensive beats Balanced.",
    "Momentum prefers the last winning move. Mean-Reversion prefers the move that beats the last winner. Breakout prefers the remaining move.",
    'Reply with JSON only: {"move":0|1|2,"reasoning":"short sentence"}',
    "The reasoning must be under 280 bytes.",
  ].join(" ");
}

export async function chooseMove(input: StrategyInput & { agentName: string; context: string }): Promise<{
  choice: Choice;
  source: "offline" | "near-ai";
}> {
  const fallback = offlineChoice(input);
  const apiKey = process.env.NEAR_AI_API_KEY?.trim();
  if (!apiKey) return { choice: fallback, source: "offline" };
  const base = (process.env.NEAR_AI_BASE_URL || "https://cloud.near.ai/v1").replace(/\/$/, "");
  const model = process.env.NEAR_AI_MODEL || "deepseek-ai/DeepSeek-V3.1";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt(input.agentName) },
          { role: "user", content: input.context },
        ],
      }),
    });
    if (!response.ok) {
      console.error(`NEAR AI HTTP ${response.status}; using offline strategy`);
      return { choice: fallback, source: "offline" };
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    const parsed = parseModelChoice(text);
    if (!parsed) {
      console.error("NEAR AI reply was not a move; using offline strategy");
      return { choice: fallback, source: "offline" };
    }
    return { choice: parsed, source: "near-ai" };
  } catch (error) {
    console.error(`NEAR AI request failed (${String(error)}); using offline strategy`);
    return { choice: fallback, source: "offline" };
  } finally {
    clearTimeout(timer);
  }
}
