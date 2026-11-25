// Token accounting for a session. Cost is only computed when the user sets
// model_pricing (input/output dollars per million tokens) — we never guess
// prices.
export function createUsage() {
  return { input: 0, output: 0, turns: 0 };
}

export function addUsage(tracker, u) {
  if (!tracker || !u) return;
  tracker.input += u.input_tokens || 0;
  tracker.output += u.output_tokens || 0;
}

export function formatUsage(tracker, pricing) {
  const lines = [
    `tokens in:  ${tracker.input}`,
    `tokens out: ${tracker.output}`,
    `turns:      ${tracker.turns}`,
  ];
  if (pricing?.input != null && pricing?.output != null) {
    const cost = (tracker.input * pricing.input + tracker.output * pricing.output) / 1e6;
    lines.push(`est. cost:  $${cost.toFixed(4)} (model_pricing)`);
  } else {
    lines.push("est. cost:  set model_pricing = { input = $/Mtok, output = $/Mtok } in config.toml");
  }
  return lines.join("\n");
}
