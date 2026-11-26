#!/usr/bin/env node
// ponytail: 1-file board viewer — node http server + polling page. No framework, no ws.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BOARD = join(dirname(fileURLToPath(import.meta.url)), "shared", "BOARD.md");
const PORT = 7777;

const PAGE = `<!doctype html><meta charset="utf-8"><title>AI Team Board</title>
<style>
body{background:#111;color:#ddd;font:14px/1.5 system-ui;max-width:900px;margin:0 auto;padding:20px}
h1{font-size:18px;color:#888}
.entry{border-left:3px solid #444;margin:12px 0;padding:8px 14px;border-radius:0 8px 8px 0;background:#1a1a1a;white-space:pre-wrap;word-break:break-word}
.entry .who{font-weight:700;margin-bottom:4px}
.claude{border-color:#d97757}.claude .who{color:#d97757}
.codex{border-color:#74aa9c}.codex .who{color:#74aa9c}
.agy{border-color:#8ab4f8}.agy .who{color:#8ab4f8}
.ts{color:#666;font-size:11px;margin-left:8px}
#status{position:fixed;top:10px;right:14px;color:#555;font-size:11px}
</style>
<h1>AI Team Board <span id="status"></span></h1><div id="log"></div>
<script>
let last = "";
async function tick(){
  try{
    const t = await (await fetch("/board")).text();
    if(t !== last){
      last = t;
      const el = document.getElementById("log");
      el.innerHTML = "";
      for(const m of t.split(/^## /m).slice(1)){
        const nl = m.indexOf("\\n");
        const head = m.slice(0, nl), body = m.slice(nl+1).trim();
        const ts = (head.match(/\\[(.*?)\\]/)||[])[1]||"";
        const who = head.replace(/\\[.*?\\]\\s*/,"").trim();
        const cls = who.includes("agy") && !who.includes("→") ? "agy" : who.startsWith("codex") ? "codex" : "claude";
        const d = document.createElement("div");
        d.className = "entry " + cls;
        d.innerHTML = '<div class="who"></div><div class="body"></div>';
        d.querySelector(".who").textContent = who;
        d.querySelector(".who").insertAdjacentHTML("beforeend", '<span class="ts">' + new Date(ts).toLocaleTimeString() + "</span>");
        d.querySelector(".body").textContent = body;
        el.appendChild(d);
      }
      window.scrollTo(0, document.body.scrollHeight);
    }
    document.getElementById("status").textContent = "live · " + new Date().toLocaleTimeString();
  }catch(e){ document.getElementById("status").textContent = "disconnected"; }
}
setInterval(tick, 2000); tick();
</script>`;

createServer((req, res) => {
  if (req.url === "/board") {
    let t = ""; try { t = readFileSync(BOARD, "utf8"); } catch {}
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(t);
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  }
}).listen(PORT, () => console.log(`Board viewer: http://localhost:${PORT}`));
