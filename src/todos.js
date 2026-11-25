// Todo list the agent maintains during a task (openclaude TodoWrite-style).
// State is per-session, kept in memory and mirrored to ~/.rtools/todos.json
// so /todos can render it between turns.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = () => path.join(os.homedir(), ".rtools", "todos.json");
const STATUSES = ["pending", "in_progress", "completed"];

export function createTodoState() {
  const todos = [];
  function validate(items) {
    if (!Array.isArray(items) || items.length === 0) throw new Error("todos must be a non-empty array");
    for (const it of items) {
      if (!it.content || typeof it.content !== "string") throw new Error("every todo needs content");
      if (!STATUSES.includes(it.status)) throw new Error(`status must be one of ${STATUSES.join("|")}`);
    }
    const active = items.filter((i) => i.status === "in_progress").length;
    if (active > 1) throw new Error(`at most one in_progress todo allowed (got ${active})`);
  }
  function persist() {
    try {
      mkdirSync(path.dirname(FILE()), { recursive: true });
      writeFileSync(FILE(), JSON.stringify(todos, null, 2));
    } catch {
      // persistence is best-effort; the in-memory list stays authoritative
    }
  }
  return {
    tool: {
      name: "todo_write",
      kind: "read",
      description:
        "Write or update the session todo list. Use for multi-step tasks: keep exactly one step in_progress, " +
        "mark steps completed as soon as they are done. Call again with the full list to update it.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: STATUSES },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      handler: async ({ todos: items }) => {
        try {
          validate(items);
        } catch (e) {
          return `Error: ${e.message}`;
        }
        todos.length = 0;
        todos.push(...items.map(({ content, status }) => ({ content, status })));
        persist();
        return `Todo list updated (${todos.length} items):\n${renderTodos(todos)}`;
      },
    },
    list: () => [...todos],
    render: () => renderTodos(todos),
  };
}

export function renderTodos(todos) {
  const mark = { pending: " ", in_progress: ">", completed: "x" };
  return todos.map((t) => `[${mark[t.status]}] ${t.content}`).join("\n") || "(no todos)";
}

export function loadTodos() {
  try {
    if (!existsSync(FILE())) return [];
    const parsed = JSON.parse(readFileSync(FILE(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
