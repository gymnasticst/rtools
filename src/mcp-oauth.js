// OAuth 2.0 authorization-code flow with PKCE for remote (HTTP) MCP servers,
// per the MCP authorization spec. Tokens cached in ~/.rtools/mcp-auth.json.
// Flow: parse WWW-Authenticate / 401 → discover metadata → dynamic client
// registration → open browser → local callback server → token exchange.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const AUTH_CACHE = path.join(os.homedir(), ".rtools", "mcp-auth.json");
const CALLBACK_PORT = 14778;
// Override in tests to exercise the timeout quickly.
const CODE_TIMEOUT_MS = Number(process.env.RTOOLS_OAUTH_CODE_TIMEOUT_MS) || 5 * 60 * 1000;

function readCache() {
  try {
    return existsSync(AUTH_CACHE) ? JSON.parse(readFileSync(AUTH_CACHE, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeCache(data) {
  mkdirSync(path.dirname(AUTH_CACHE), { recursive: true });
  const existed = existsSync(AUTH_CACHE);
  writeFileSync(AUTH_CACHE, JSON.stringify(data, null, 2), { mode: 0o600 });
  if (existed) chmodSync(AUTH_CACHE, 0o600); // mode only applies on creation
}

function b64url(buf) {
  return buf.toString("base64url");
}

async function discoverMetadata(serverUrl) {
  const origin = new URL(serverUrl).origin;
  for (const u of [
    `${origin}/.well-known/oauth-authorization-server`,
    new URL("/.well-known/oauth-authorization-server/mcp", serverUrl).toString(),
  ]) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (res.ok) return await res.json();
    } catch {
      // try next location
    }
  }
  throw new Error(`OAuth metadata discovery failed for ${serverUrl}`);
}

async function dynamicRegister(metadata, serverUrl) {
  if (!metadata.registration_endpoint) throw new Error("registry has no registration_endpoint (pre-registered client required)");
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "RTools CLI",
      redirect_uris: [`http://127.0.0.1:${CALLBACK_PORT}/callback`],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
      response_types: ["code"],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`dynamic client registration failed: HTTP ${res.status}`);
  return res.json();
}

function authorizeAndWaitForCode({ metadata, client, serverUrl, verifier }) {
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", serverUrl);

  const codePromise = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      // keep-alive connections (an already-open browser tab) would otherwise
      // keep the event loop alive after the flow ended
      server.closeAllConnections?.();
      fn(arg);
    };
    const fail = (err) => settle(reject, err);
    const succeed = (code) => settle(resolve, code);

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url, redirectUri);
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      if (reqUrl.searchParams.get("state") !== state) {
        res.writeHead(400).end("state mismatch");
        fail(new Error("OAuth state mismatch"));
        return;
      }
      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>RTools: authorization complete. You can close this tab.</h1>");
      if (error || !code) fail(new Error(`OAuth failed: ${error || "no code"}`));
      else succeed(code);
    });
    server.on("error", (err) => fail(new Error(`OAuth callback server failed on port ${CALLBACK_PORT}: ${err.message}`)));
    const timer = setTimeout(
      () => fail(new Error(`OAuth authorization timed out after ${CODE_TIMEOUT_MS / 1000}s — no callback received`)),
      CODE_TIMEOUT_MS,
    );
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });

  console.error(`\nOpening browser to authorize ${serverUrl}...\n${authUrl.toString()}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  try {
    const child = spawn(opener, process.platform === "win32" ? ["/c", "start", authUrl.toString()] : [authUrl.toString()], { stdio: "ignore", detached: true });
    child.on("error", () => {
      console.error("(no browser available in this environment — open the URL above manually, then the flow continues)");
    });
    child.unref();
  } catch {
    // headless: the URL is printed above for manual opening
  }
  return codePromise;
}

async function exchangeCode({ metadata, client, code, verifier, serverUrl }) {
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: `http://127.0.0.1:${CALLBACK_PORT}/callback`,
      code_verifier: verifier,
      resource: serverUrl,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function getMcpAccessToken(serverName, serverUrl) {
  const cache = readCache();
  const cached = cache[serverName];
  if (cached?.access_token && cached.expires_at > Date.now() + 60000) return cached.access_token;

  const metadata = await discoverMetadata(serverUrl);
  const client = await dynamicRegister(metadata, serverUrl);
  const verifier = b64url(randomBytes(32));
  const code = await authorizeAndWaitForCode({ metadata, client, serverUrl, verifier });
  const tokens = await exchangeCode({ metadata, client, code, verifier, serverUrl });
  cache[serverName] = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  };
  writeCache(cache);
  return tokens.access_token;
}

export async function authorizedFetch(serverUrl, body, token) {
  return fetch(serverUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
