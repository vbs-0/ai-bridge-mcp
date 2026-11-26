#!/usr/bin/env node
// ponytail: PTY wrapper around freebuff's TUI — one server gives the user a live
// browser terminal (watch + type) AND gives Claude an HTTP control channel
// (POST /input, GET /screen). Fragile by nature (screen scraping); drop the scraping
// half the day freebuff ships a real headless mode.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import xterm from "@xterm/headless";

const PORT = 7778;
const CWD = process.argv[2] || process.cwd();
const MAX_BUF = 512 * 1024;

// freebuff's session timer burns clock-time even when idle — so we stop the process
// after IDLE_MS and relaunch with --continue on the next ask (resumes the conversation).
const IDLE_MS = 5 * 60 * 1000;
let term = null, alive = false, everRan = false, lastUse = Date.now();

function spawnFreebuff() {
  const args = ["/c", everRan ? "freebuff --continue" : "freebuff"];
  term = pty.spawn("cmd.exe", args, {
    name: "xterm-256color", cols: shadow?.cols || 120, rows: shadow?.rows || 32, cwd: CWD, env: process.env,
  });
  alive = true; everRan = true; lastUse = Date.now();
  term.onData(onData);
  term.onExit(({ exitCode }) => {
    alive = false;
    const msg = `\r\n[freebuff stopped (code ${exitCode}) — auto-resumes on next task]\r\n`;
    onData(msg);
  });
}

setInterval(() => {
  if (alive && Date.now() - lastUse > IDLE_MS) {
    onData("\r\n[idle 5min — stopping freebuff to save session time]\r\n");
    try { term.kill(); } catch {}
    alive = false;
  }
}, 30000);

let buf = "";
const sockets = new Set();
// headless emulator mirrors the real screen so /screen returns rendered state,
// not a raw stream (TUI animations make the stream useless)
const shadow = new xterm.Terminal({ cols: 120, rows: 32, scrollback: 2000, allowProposedApi: true });
function onData(d) {
  buf = (buf + d).slice(-MAX_BUF);
  shadow.write(d);
  for (const ws of sockets) if (ws.readyState === 1) ws.send(d);
}
spawnFreebuff();

function screenText() {
  const b = shadow.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// strip ANSI/CSI/OSC so Claude gets readable text
const stripAnsi = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
   .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
   .replace(/\x1b[()][A-Z0-9]/g, "")
   .replace(/[\x00-\x08\x0b-\x1f]/g, "")
   .replace(/\n{3,}/g, "\n\n");

const PAGE = `<!doctype html><meta charset="utf-8"><title>Freebuff Live</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>body{margin:0;background:#000}#t{height:100vh}</style>
<div id="t"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script>
const term = new Terminal({fontSize:14, theme:{background:"#000"}});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("t"));
fit.fit();
const ws = new WebSocket("ws://" + location.host + "/ws");
ws.onmessage = (e) => term.write(e.data);
term.onData((d) => ws.send(d));
window.onresize = () => { fit.fit(); fetch("/resize?cols=" + term.cols + "&rows=" + term.rows, {method:"POST"}); };
ws.onopen = () => fetch("/resize?cols=" + term.cols + "&rows=" + term.rows, {method:"POST"});
</script>`;

// ---- atomic ask queue ----------------------------------------------------
// Multiple Claude sessions + the dashboard share this one PTY. Concurrent typing
// interleaves keystrokes and corrupts prompts, so /ask serializes: type → verify
// echo → submit → wait for reply → extract. One at a time, FIFO.
let chain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = (s) => (s.match(/\[\d{1,2}:\d{2} [AP]M\]/g) || []).length;

function cleanReply(s) {
  return s
    .replace(/[█╔╗╚╝║═╭╮╰╯│─◐▁▂▃]{2,}/g, "")
    .replace(/Enter a coding task or \/ for commands/g, "")
    .replace(/\d+(\.\d+)? of 5 sessions used.*$/gm, "")
    .replace(/DeepSeek.*End session\s*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// wake/respawn freebuff and click through interstitials until the input box shows
async function ensureReady() {
  if (!alive) spawnFreebuff();
  for (let i = 0; i < 45; i++) {
    const s = screenText();
    if (/Enter a coding task/.test(s)) return true;
    if (/Press Enter to continue|RECOMMENDED|Start coding for free/.test(s)) { term.write("\r"); await sleep(3000); continue; }
    await sleep(2000);
  }
  return /Enter a coding task/.test(screenText());
}

async function doAsk(prompt) {
  lastUse = Date.now();
  if (!(await ensureReady())) return "ERROR: freebuff did not reach a ready state (check http://localhost:7778)";
  const oneLine = prompt.replace(/\r?\n/g, " ").trim();
  const before = screenText();
  const baseCount = headers(before);
  // type and verify the echo landed (retry once if keystrokes got eaten)
  for (let attempt = 0; attempt < 2; attempt++) {
    term.write(oneLine);
    await sleep(1200);
    if (screenText().includes(oneLine.slice(0, 40))) break;
    // clear whatever partial state the input box is in
    term.write("\x15"); // ctrl+u clear line
    await sleep(400);
  }
  term.write("\r");
  // wait for our message header to render (freebuff stamps sent messages)
  let now = "";
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    now = screenText();
    if (headers(now) > baseCount) break;
  }
  // wait for the reply to settle: 4 identical polls
  let prev = now, stable = 0, settled = false;
  for (let i = 0; i < 90; i++) {
    await sleep(3000);
    now = screenText();
    if (now === prev) { if (++stable >= 4) { settled = true; break; } }
    else stable = 0;
    prev = now;
  }
  let out = settled ? now : prev + "\n[freebuff: timed out waiting for reply]";
  const m = [...out.matchAll(/\[\d{1,2}:\d{2} [AP]M\]/g)];
  if (m.length) out = out.slice(m[m.length - 1].index);
  lastUse = Date.now();
  return cleanReply(out);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  if (url.pathname === "/screen") {
    const n = Number(url.searchParams.get("chars")) || 6000;
    return res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(screenText().slice(-n));
  }
  if (url.pathname === "/ask" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const job = chain.then(() => doAsk(body));
      chain = job.catch(() => {}); // keep the queue alive on errors
      job.then((out) => res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(out))
         .catch((e) => res.writeHead(500).end(String(e)));
    });
    return;
  }
  if (url.pathname === "/input" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!alive) spawnFreebuff();
      lastUse = Date.now();
      term.write(body);
      res.writeHead(200).end("sent");
    });
    return;
  }
  if (url.pathname === "/resize" && req.method === "POST") {
    const cols = Number(url.searchParams.get("cols")), rows = Number(url.searchParams.get("rows"));
    if (cols > 0 && rows > 0) { try { term.resize(cols, rows); } catch {} shadow.resize(cols, rows); }
    return res.writeHead(200).end("ok");
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.send(buf.slice(-100000)); // replay recent screen
  ws.on("message", (m) => { if (!alive) spawnFreebuff(); lastUse = Date.now(); term.write(m.toString()); });
  ws.on("close", () => sockets.delete(ws));
});

server.listen(PORT, () => console.log(`Freebuff live terminal: http://localhost:${PORT} (cwd: ${CWD})`));
