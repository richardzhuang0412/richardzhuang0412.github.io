#!/usr/bin/env node
// Try-on prototype server. Zero dependencies (Node >= 18).
//   node server/server.mjs            -> http://localhost:8787
// Serves the studio web app, proxies product pages / images (CORS), and runs
// the AI try-on providers so API keys never reach the browser.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";
import net from "node:net";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// --- tiny .env loader -------------------------------------------------------
for (const f of [path.join(here, ".env"), path.join(root, ".env")]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const { PROVIDERS, pickProvider } = await import("./providers.mjs");

const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...headers,
  });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8" });

// Refuse to proxy to private / loopback addresses (basic SSRF guard).
async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error("bad url"), { status: 400 });
  }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error("only http(s)"), { status: 400 });
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  for (const { address } of addrs) {
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd|fe80)/i.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address))
      throw Object.assign(new Error("private address not allowed"), { status: 403 });
  }
  return u;
}

async function proxy(res, raw, kind) {
  const u = await assertPublicUrl(raw);
  const r = await fetch(u, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      accept: kind === "image" ? "image/avif,image/webp,image/*,*/*;q=0.8" : "text/html,application/xhtml+xml,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: u.origin + "/",
    },
    signal: AbortSignal.timeout(15000),
  });
  const type = r.headers.get("content-type") || "";
  if (kind === "image" && !type.startsWith("image/")) return json(res, 415, { error: "not an image: " + type });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) return json(res, 413, { error: "too large" });
  send(res, r.status, buf, { "content-type": type || "application/octet-stream", "cache-control": "max-age=300" });
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(res, pathname) {
  if (pathname === "/") return send(res, 302, "", { location: "/extension/studio/studio.html" });
  const file = path.resolve(root, "." + decodeURIComponent(pathname));
  if (
    !file.startsWith(root + path.sep) ||
    file.includes(`${path.sep}server${path.sep}.env`) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  )
    return send(res, 404, "not found");
  send(res, 200, fs.readFileSync(file), { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (url.pathname === "/api/health")
      return json(res, 200, {
        ok: true,
        providers: Object.values(PROVIDERS)
          .filter((p) => p.name !== "mock" && p.available())
          .map((p) => p.name),
      });
    if (url.pathname === "/api/fetch") return await proxy(res, url.searchParams.get("url"), "page");
    if (url.pathname === "/api/image") return await proxy(res, url.searchParams.get("url"), "image");
    if (url.pathname === "/api/tryon" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (!body.person || !Array.isArray(body.garments) || !body.garments.length) return json(res, 400, { error: "need person + garments" });
      const provider = pickProvider(body.provider);
      const t0 = Date.now();
      console.log(`[tryon] ${provider.name}: ${body.garments.map((g) => g.category).join(", ")}`);
      const out = await provider.run(body);
      console.log(`[tryon] ${provider.name} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return json(res, 200, { provider: provider.name, ...out });
    }
    if (req.method === "GET") return serveStatic(res, url.pathname);
    send(res, 405, "method not allowed");
  } catch (e) {
    console.error("[error]", e.message);
    json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  const live = Object.values(PROVIDERS)
    .filter((p) => p.available())
    .map((p) => p.name);
  console.log(`Try-on studio:  http://localhost:${PORT}/`);
  console.log(
    `Providers:      ${live.join(", ")}${live.length === 1 ? "  (add GEMINI_API_KEY / FASHN_API_KEY to server/.env for real renders)" : ""}`
  );
});
