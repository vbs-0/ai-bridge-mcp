#!/usr/bin/env node
// ponytail: one-file mission control — agents status, live run output, board feed,
// usage stats, direct-ask, kill. Polling over websockets; a 2s refresh is plenty.
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { BOARD, USAGE, EVENTS, RUNS, AGENTS, tailOf, runAgent, askFreebuff } from "./lib.js";

const PORT = 7779;

function jsonl(file) {
  try { return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; }
}

function state() {
  const events = jsonl(EVENTS).slice(-200);
  const ended = new Set(events.filter((e) => e.ev === "end").map((e) => e.runId));
  const running = events.filter((e) => e.ev === "start" && !ended.has(e.runId));
  const usage = jsonl(USAGE);
  const by = {};
  for (const e of usage) {
    const k = e.agent;
    by[k] ||= { calls: 0, tokens: 0, secs: 0, errors: 0 };
    by[k].calls++; by[k].tokens += e.tokens || 0; by[k].secs += e.secs || 0; if (e.error) by[k].errors++;
  }
  let runs = [];
  try {
    runs = readdirSync(RUNS).filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, m: statSync(join(RUNS, f)).mtimeMs, size: statSync(join(RUNS, f)).size }))
      .sort((a, b) => b.m - a.m).slice(0, 30);
  } catch {}
  return { running, events: events.slice(-60).reverse(), usage: by, runs, board: tailOf(BOARD, 20000, ""), freebuff: null };
}

// read per-request so UI edits don't need a server restart
const page = () => readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => res.writeHead(code, { "content-type": type + "; charset=utf-8" }).end(body);

  if (url.pathname === "/") return send(200, page(), "text/html");
  if (url.pathname === "/state") return send(200, JSON.stringify(state()));
  if (url.pathname === "/runlog") {
    const f = (url.searchParams.get("f") || "").replace(/[^\w.-]/g, "");
    const p = join(RUNS, f);
    return send(200, existsSync(p) ? tailOf(p, 20000, "") : "(no log)", "text/plain");
  }
  if (url.pathname === "/kill" && req.method === "POST") {
    const pid = Number(url.searchParams.get("pid"));
    if (!pid) return send(400, "bad pid", "text/plain");
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
    return send(200, "killed", "text/plain");
  }
  if (url.pathname === "/ask" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { agent, prompt, cwd, effort, source, task_type } = JSON.parse(body);
        if (agent === "freebuff") {
          send(200, "started", "text/plain");
          await askFreebuff(prompt, { source: source || "user", task_type: task_type || "manual" });
          return;
        }
        if (!AGENTS[agent]) return send(400, "unknown agent", "text/plain");
        send(200, "started", "text/plain"); // reply immediately; progress visible in runs
        await runAgent(agent, { prompt, cwd: cwd || undefined, effort: effort || undefined, task_type: task_type || "manual" }, { source: source || "user" });
      } catch (e) { try { send(500, String(e), "text/plain"); } catch {} }
    });
    return;
  }
  send(404, "not found", "text/plain");
}).listen(PORT, () => console.log(`AI team dashboard: http://localhost:${PORT}`));
