// Wire adapters for three provider types, all streaming.
// Internal message format is OpenAI-chat style:
//   {role:"system"|"user", content}
//   {role:"assistant", content, tool_calls?:[{id, function:{name, arguments}}]}
//   {role:"tool", tool_call_id, content}

function authHeaders(provider, apiKey) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

// Image support: a user message may carry `images: [{path, media_type, data(base64)}]`.
// Converted to OpenAI content parts / Anthropic image blocks per wire API.
function withImages(messages) {
  return messages.map((m) => {
    if (m.role !== "user" || !m.images?.length || typeof m.content !== "string") return m;
    const parts = [{ type: "text", text: m.content }];
    for (const img of m.images) {
      parts.push({ type: "image_url", image_url: { url: `data:${img.media_type};base64,${img.data}` } });
    }
    return { ...m, content: parts };
  });
}

function buildUrl(provider, pathPart) {
  const url = new URL(provider.base_url.replace(/\/+$/, "") + pathPart);
  for (const [k, v] of Object.entries(provider.query_params || {})) url.searchParams.set(k, v);
  return url.toString();
}

function extraHeaders(provider, apiKey) {
  return { ...authHeaders(provider, apiKey), ...(provider.http_headers || {}) };
}

async function* sseData(res) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return { _raw: s };
  }
}

// ---------- OpenAI /chat/completions ----------

async function streamChat({ provider, apiKey, model, messages, tools, onText, settings = {} }) {
  const body = { model, messages: withImages(messages), stream: true };
  for (const key of ["temperature", "top_p", "max_output_tokens"]) {
    if (settings[key] !== undefined && settings[key] !== null) body[key] = settings[key];
  }
  if (settings.verbosity && settings.verbosity !== "medium") body.verbosity = settings.verbosity;
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  const res = await fetch(buildUrl(provider, "/chat/completions"), {
    method: "POST",
    headers: extraHeaders(provider, apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Provider HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const text = [];
  const acc = new Map();
  for await (const data of sseData(res)) {
    if (data === "[DONE]") break;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = ev.choices?.[0]?.delta || {};
    if (delta.content) {
      text.push(delta.content);
      onText?.(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const cur = acc.get(idx) || { id: "", name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      acc.set(idx, cur);
    }
  }
  return { text: text.join(""), toolCalls: [...acc.values()].filter((t) => t.name) };
}

// ---------- OpenAI /responses ----------

async function streamResponses({ provider, apiKey, model, messages, tools, onText, settings = {} }) {
  const input = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "user") {
      input.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      if (m.content) input.push({ role: "assistant", content: m.content });
      for (const tc of m.tool_calls || []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
    }
  }
  const body = { model, input, stream: true };
  body.reasoning = { effort: settings.effort || "medium", summary: settings.reasoningSummary || "auto" };
  if (settings.verbosity && settings.verbosity !== "medium") body.text = { verbosity: settings.verbosity };
  for (const key of ["temperature", "top_p", "max_output_tokens"]) {
    if (settings[key] !== undefined && settings[key] !== null) body[key] = settings[key];
  }
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  const res = await fetch(buildUrl(provider, "/responses"), {
    method: "POST",
    headers: extraHeaders(provider, apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Provider HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const text = [];
  const toolCalls = [];
  for await (const data of sseData(res)) {
    if (data === "[DONE]") break;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.type === "response.output_text.delta") {
      text.push(ev.delta);
      onText?.(ev.delta);
    } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
      toolCalls.push({ id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments || "{}" });
    }
  }
  return { text: text.join(""), toolCalls };
}

// ---------- Anthropic /v1/messages ----------

async function streamAnthropic({ provider, apiKey, model, messages, tools, onText, settings = {} }) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const msgs = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const content = [{ type: "text", text: m.content }];
      for (const img of m.images || []) {
        content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
      }
      msgs.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls || []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
      }
      if (blocks.length) msgs.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] });
    }
  }
  const body = { model, max_tokens: settings.max_output_tokens || 8192, messages: msgs, stream: true };
  if (system) body.system = system;
  if (settings.temperature !== undefined && settings.temperature !== null) body.temperature = settings.temperature;
  if (settings.top_p !== undefined && settings.top_p !== null) body.top_p = settings.top_p;
  if (tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(provider.http_headers || {}),
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(buildUrl(provider, "/v1/messages"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Provider HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const text = [];
  const blocks = new Map();
  for await (const data of sseData(res)) {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, arguments: "" });
    } else if (ev.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta") {
        text.push(ev.delta.text);
        onText?.(ev.delta.text);
      } else if (ev.delta?.type === "input_json_delta") {
        const b = blocks.get(ev.index);
        if (b) b.arguments += ev.delta.partial_json;
      }
    }
  }
  return { text: text.join(""), toolCalls: [...blocks.values()].filter((b) => b.name).map((b) => ({ id: b.id, name: b.name, arguments: b.arguments || "{}" })) };
}

// List model ids from an OpenAI-compatible /models or Anthropic /v1/models endpoint.
export async function listModels({ provider, apiKey }) {
  const pathPart = provider.wire_api === "anthropic" ? "/v1/models" : "/models";
  const res = await fetch(buildUrl(provider, pathPart), { headers: extraHeaders(provider, apiKey) });
  if (!res.ok) throw new Error(`Provider HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const items = data.data || data.models || [];
  return items.map((m) => m.id || m.name).filter(Boolean).sort();
}

const ADAPTERS = { chat: streamChat, responses: streamResponses, anthropic: streamAnthropic };

export function stream(opts) {
  const adapter = ADAPTERS[opts.provider.wire_api];
  if (!adapter) {
    throw new Error(`Unknown wire_api "${opts.provider.wire_api}" (supported: chat, responses, anthropic)`);
  }
  return adapter(opts);
}
