// Drag & drop / paste attach: when a file is dragged into the terminal input
// window, the terminal pastes its path (quoted, file:// URI, backslash-escaped
// or bare). parseDroppedFiles turns those pasted paths into real attachments:
// text files are inlined into the prompt, images are attached as base64 image
// parts the providers already send to vision models (providers.js).
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const TEXT_MAX = 20000;
const IMAGE_MAX = 20 * 1024 * 1024;

const TOKEN = /file:\/\/[^\s"']+|"([^"]+)"|'([^']+)'|((?:[^\s"']|\\ )+)/g;

function mediaType(abs) {
  if (/\.png$/i.test(abs)) return "image/png";
  if (/\.gif$/i.test(abs)) return "image/gif";
  if (/\.webp$/i.test(abs)) return "image/webp";
  return "image/jpeg";
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function parseDroppedFiles(input, cwd) {
  const attachments = [];
  const notices = [];
  const seen = new Set();
  let prompt = "";
  let last = 0;

  for (const m of input.matchAll(TOKEN)) {
    const raw = m[0];
    const candidate = raw.startsWith("file://")
      ? decodeURIComponent(raw.slice("file://".length))
      : m[1] !== undefined ? m[1]
      : m[2] !== undefined ? m[2]
      : m[3].replace(/\\(.)/g, "$1");
    let abs = null;
    try {
      abs = candidate.startsWith("~") ? path.join(cwd, candidate.slice(1)) : path.resolve(cwd, candidate);
    } catch {
      // unresolvable — keep the text as is
    }
    const isFile = abs && existsSync(abs) && statSync(abs).isFile();
    const repeat = seen.has(abs);
    if (isFile) seen.add(abs);
    if (!isFile || repeat) continue; // ordinary words stay in the prompt untouched
    const rel = path.relative(cwd, abs) || abs;
    // Text between this token and the previous handled one belongs in the
    // prompt no matter how this token itself is handled (image, skipped or
    // inlined) — otherwise words like "explain a.png then b.png" lose "then".
    prompt += input.slice(last, m.index);
    if (IMAGE_EXT.test(abs)) {
      const size = statSync(abs).size;
      if (size > IMAGE_MAX) {
        notices.push(`@${rel}: image too large (${size} bytes, max ${IMAGE_MAX}) — skipped`);
      } else {
        attachments.push({ path: abs, rel, media_type: mediaType(abs), data: readFileSync(abs).toString("base64") });
        notices.push(`attached image: @${rel} (${size} bytes)`);
      }
    } else {
      const buf = readFileSync(abs);
      if (looksBinary(buf)) {
        notices.push(`@${rel}: binary file — skipped (use a shell tool to work with it)`);
      } else {
        const body = buf.toString("utf8").slice(0, TEXT_MAX);
        attachments.push({ path: abs, rel, text: true });
        prompt += `\n--- file: ${rel} ---\n${body}\n--- end of ${rel} ---\n`;
        notices.push(`attached: @${rel}`);
      }
    }
    last = m.index + raw.length;
  }
  prompt += input.slice(last);
  return { prompt: prompt.trim(), attachments, notices };
}
