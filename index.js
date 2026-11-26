#!/usr/bin/env node
// ponytail: MCP facade over lib.js (shared with dashboard.js). Files are the database.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, readFileSync } from "node:fs";
import { BOARD, PATTERNS, USAGE, AGENTS, tailOf, post, runAgent, askFreebuff } from "./lib.js";

function usageStats() {
  let lines;
  try { lines = readFileSync(USAGE, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return "No usage recorded yet."; }
  const by = {};
  for (const e of lines) {
    const k = `${e.agent} | ${e.task_type || "untyped"}`;
    by[k] ||= { calls: 0, tokens: 0, secs: 0, errors: 0 };
    by[k].calls++; by[k].tokens += e.tokens || 0; by[k].secs += e.secs || 0; if (e.error) by[k].errors++;
  }
  return Object.entries(by).map(([k, v]) =>
    `${k}: ${v.calls} calls, ${v.tokens} tokens, avg ${(v.secs / v.calls).toFixed(0)}s/call, ${v.errors} errors`).join("\n")
    + "\n\nRaw ledger: " + USAGE + "\nDashboard: http://localhost:7779";
}

const askSchema = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "The task to send. Must be self-contained (repo path, files, commands)." },
    cwd: { type: "string", description: "Working directory to run in (optional)" },
    include_board: { type: "boolean", description: "Prepend recent team board as context (default true)" },
    task_type: { type: "string", description: "Category for the usage ledger, e.g. build/test/audit/review/research/fix" },
    model: { type: "string", description: "Model override (codex: e.g. gpt-5.1-codex; agy: gemini model name). Omit for default." },
    effort: { type: "string", description: "codex only: reasoning effort — low/medium/high (minimal maps to low). Omit for default." },
  },
  required: ["prompt"],
};

// "claude" in AGENTS is dashboard-only (spawning myself as a tool = recursion + cost)
const DELEGATES = Object.keys(AGENTS).filter((l) => l !== "claude");

const TOOLS = [
  { name: "board_read", description: "Read the shared AI team board (chat + memory between Claude, Codex, Agy, Freebuff).", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "board_post", description: "Post a message/note/status to the shared AI team board.", inputSchema: { type: "object", properties: { author: { type: "string" }, message: { type: "string" } }, required: ["message"] } },
  { name: "patterns_read", description: "Read PATTERNS.md — learned efficiency notes on which agent/model/effort works best per task type. Consult before assigning roles.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "patterns_note", description: "Append an efficiency observation to PATTERNS.md.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
  { name: "usage_stats", description: "Aggregated usage from the ledger: calls/tokens/avg-duration/errors per agent per task_type. Use to pick the cheapest capable agent.", inputSchema: { type: "object", properties: {}, required: [] } },
  {
    name: "ask_freebuff",
    description: "Delegate a prompt to freebuff (free ad-supported agent, ~5 sessions/day, DeepSeek models) live in the PTY terminal at http://localhost:7778 — user can watch/type there too. Reply scraped from the TUI screen (includes its visible thinking). Requires term-server.js running. Don't send sensitive code (trains on data).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task. Keep single-line; it is typed into the TUI." },
        task_type: { type: "string", description: "Category for the usage ledger" },
      },
      required: ["prompt"],
    },
  },
  ...DELEGATES.map((label) => ({
    name: "ask_" + label,
    description: `Delegate a prompt to ${label} CLI (existing logged-in session, no API key). Team board auto-prepended as shared context; prompt+reply auto-posted to board; live output streams to the dashboard (http://localhost:7779).`,
    inputSchema: askSchema,
  })),
];

const server = new Server({ name: "ai-bridge", version: "4.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const a = req.params.arguments || {};
  const text = (t) => ({ content: [{ type: "text", text: t }] });

  if (name === "board_read") return text(tailOf(BOARD, 30000, "(board empty)"));
  if (name === "board_post") { post(a.author || "claude", a.message); return text("posted"); }
  if (name === "patterns_read") return text(tailOf(PATTERNS, 30000, "(no patterns recorded yet)"));
  if (name === "patterns_note") { appendFileSync(PATTERNS, `\n- [${new Date().toISOString().slice(0, 10)}] ${a.note.trim()}\n`); return text("noted"); }
  if (name === "usage_stats") return text(usageStats());

  if (name === "ask_freebuff") {
    const { output, secs } = await askFreebuff(a.prompt, { source: "claude", task_type: a.task_type || null });
    return text(output + `\n\n[bridge: ${secs}s]`);
  }

  const label = name.replace("ask_", "");
  if (!DELEGATES.includes(label)) throw new Error(`Unknown tool: ${name}`);
  const { output, secs, tokens } = await runAgent(label, a, { source: "claude" });
  return text(output + `\n\n[bridge: ${secs}s${tokens ? `, ${tokens} tokens` : ""}]`);
});

await server.connect(new StdioServerTransport());
