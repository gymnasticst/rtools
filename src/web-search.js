// web_search tool (Codex-style: enabled via [tools] web_search = true)
// Real live web search through public APIs, no key required:
//   1. DuckDuckGo Instant Answer API (api.duckduckgo.com)
//   2. Wikipedia full-text search API
// Results include a URL and a snippet.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function clean(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

export function webSearchTool({ maxResults = 5 }) {
  return {
    name: "web_search",
    kind: "read",
    description: "Search the public web and return results (title, url, snippet).",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    handler: async ({ query }) => {
      const results = [];
      const curl = (url) =>
        run("curl", ["-s", "-m", "15", "-A", "rtools-cli", url], { timeout: 20000, maxBuffer: 5 * 1024 * 1024 });
      // 1) DuckDuckGo Instant Answer API
      try {
        const { stdout } = await curl(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`
        );
        const ddg = JSON.parse(stdout);
        if (ddg.AbstractURL && ddg.AbstractText) {
          results.push(`1. ${ddg.Heading || query}\n   ${ddg.AbstractURL}\n   ${clean(ddg.AbstractText).slice(0, 200)}`);
        }
        for (const topic of ddg.RelatedTopics || []) {
          if (results.length >= maxResults) break;
          if (topic.FirstURL && topic.Text) {
            results.push(`${results.length + 1}. ${topic.Text.split(" - ")[0]}\n   ${topic.FirstURL}\n   ${clean(topic.Text).slice(0, 200)}`);
          }
        }
      } catch {
        // fall through to Wikipedia
      }
      // 2) Wikipedia full-text search
      if (results.length < maxResults) {
        try {
          const { stdout } = await curl(
            `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=${maxResults}&format=json&srsearch=${encodeURIComponent(query)}`
          );
          for (const r of JSON.parse(stdout).query?.search || []) {
            if (results.length >= maxResults) break;
            const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`;
            const snippet = clean(r.snippet || "");
            if (!results.some((x) => x.includes(url))) {
              results.push(`${results.length + 1}. ${r.title}\n   ${url}\n   ${snippet.slice(0, 200)}`);
            }
          }
        } catch {
          // both providers failed
        }
      }
      if (!results.length) {
        return "No results found (both DuckDuckGo and Wikipedia APIs failed).";
      }
      return results.slice(0, maxResults).join("\n");
    },
  };
}
