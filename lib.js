// Shared agent-spawn logic used by both the MCP bridge (index.js) and dashboard.js.
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, statSync, mkdirSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SHARED = join(HERE, "shared");
export const BOARD = join(SHARED, "BOARD.md");
export const PATTERNS = join(SHARED, "PATTERNS.md");
export const USAGE = join(SHARED, "usage.jsonl");
export const EVENTS = join(SHARED, "events.jsonl");
export const RUNS = join(SHARED, "runs");
export const REPORTS = join(SHARED, "reports");
mkdirSync(RUNS, { recursive: true });
mkdirSync(REPORTS, { recursive: true });

// Auto-archive an agent reply under reports/<project>/ so future sessions and other
// agents can read past work. Project = basename of the cwd the task ran in.
export function archiveReport({ agent, task_type, cwd, prompt, output }) {
  try {
    const project = (cwd || process.cwd()).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "misc";
    const dir = join(REPORTS, project);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const file = join(dir, `${stamp}-${agent}${task_type ? "-" + task_type : ""}.md`);
    appendFileSync(file, `# ${agent}${task_type ? ` [${task_type}]` : ""} — ${new Date().toISOString()}\n\n## Task\n${prompt}\n\n## Reply\n${output}\n`);
    return file;
  } catch { return null; }
}

// Agent CLIs. Set these when the binary is not on PATH (on Windows the npm
// wrappers are .cmd files, which need their full path here).
const CODEX = process.env.CODEX_CLI || "codex";
const AGY = process.env.AGY_CLI || "agy";
const CLAUDE_CLI = process.env.CLAUDE_CLI || "claude";

export const TEAM_PREAMBLE = (agent) =>
`You are ${agent}, part of an AI team (Claude Code = lead, Codex, Agy, Freebuff) working for one human user.
Team board (shared chat + memory, markdown, append-only): ${BOARD}
Recent board contents below. Your reply is AUTO-POSTED to the board — the other AIs and the user will read it there.
To address a teammate, just write e.g. "@codex: ..." in your reply; the lead relays tasks between agents.
You may also read the board file yourself for full history.
Past reports are archived per project under: ${REPORTS}\\<project-folder-name>\\ — read relevant ones before redoing analysis.
--- BOARD (recent) ---
${tailOf(BOARD)}
--- END BOARD ---

Task:
`;

export const AGENTS = {
  // claude here = a FRESH headless claude-code instance (costs Claude credits; the
  // interactive session is separate). Used from the dashboard, not exposed as an MCP tool.
  claude: {
    build: ({ model }) => {
      // prompt goes via stdin: .cmd needs shell:true, and shell mangles multiline args
      const args = ["--dangerously-skip-permissions", "-p"];
      if (model) args.unshift("--model", model);
      return { cmd: CLAUDE_CLI, args, stdin: true, shell: true };
    },
  },
  codex: {
    build: ({ model, effort }) => {
      const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write"];
      if (model) args.push("-c", `model="${model}"`);
      // ponytail: "minimal" is rejected while web_search/image_gen are enabled — low is close enough
      if (effort) args.push("-c", `model_reasoning_effort="${effort === "minimal" ? "low" : effort}"`);
      args.push("-");
      return { cmd: CODEX, args, stdin: true };
    },
  },
  agy: {
    build: ({ model }) => {
      const args = ["--dangerously-skip-permissions"];
      if (model) args.push("--model", model);
      args.push("-p");
      return { cmd: AGY, args, promptArg: true };
    },
  },
};

export function tailOf(file, chars = 8000, fallback = "(empty)") {
  try { const t = readFileSync(file, "utf8"); return t.slice(-chars); } catch { return fallback; }
}

export function post(author, message) {
  appendFileSync(BOARD, `\n## [${new Date().toISOString()}] ${author}\n${message.trim()}\n`);
}

export function logUsage(entry) { appendFileSync(USAGE, JSON.stringify(entry) + "\n"); }
export function logEvent(entry) { appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); }

// ponytail: agy -p never prints to stdout (CLI bug) — scrape its brain transcript
const AGY_BRAIN = process.env.AGY_BRAIN || join(homedir(), ".gemini", "antigravity-cli", "brain");
export function agyLastReply(since) {
  try {
    const convs = readdirSync(AGY_BRAIN)
      .map((d) => ({ d, f: join(AGY_BRAIN, d, ".system_generated", "logs", "transcript.jsonl") }))
      .filter(({ f }) => { try { return statSync(f).mtimeMs >= since; } catch { return false; } })
      .sort((a, b) => statSync(b.f).mtimeMs - statSync(a.f).mtimeMs);
    if (!convs.length) return null;
    const lines = readFileSync(convs[0].f, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = JSON.parse(lines[i]);
      if (m.source === "MODEL" && m.content) return m.content;
    }
  } catch {}
  return null;
}

// ponytail: freebuff has no headless mode — driven via term-server.js PTY (port 7778)
const FREEBUFF_URL = "http://localhost:7778";
export async function askFreebuff(prompt, { source = "claude", task_type = null } = {}) {
  post(`${source} → freebuff${task_type ? ` [${task_type}]` : ""}`, prompt);
  const started = Date.now();
  // TUI can't take an 8KB preamble typed in — one short team line instead.
  // term-server /ask serializes concurrent asks (multiple sessions share one PTY).
  const oneLine = `[team msg from ${source}; board: ${BOARD}] ` + prompt.replace(/\r?\n/g, " ");
  let output;
  try {
    output = await (await fetch(FREEBUFF_URL + "/ask", { method: "POST", body: oneLine })).text();
  } catch {
    output = "ERROR: freebuff terminal not running. Start it: node term-server.js [cwd] — live view: " + FREEBUFF_URL;
  }
  const secs = Math.round((Date.now() - started) / 1000);
  logUsage({ ts: new Date().toISOString(), agent: "freebuff", task_type, model: "default", effort: "default", secs, tokens: null, error: output.startsWith("ERROR:"), prompt_chars: prompt.length });
  post("freebuff", output.slice(-6000));
  archiveReport({ agent: "freebuff", task_type, cwd: null, prompt, output });
  return { output, secs, tokens: null };
}

// Spawn an agent CLI: streams live output to shared/runs/<id>.log, logs start/end
// events, posts prompt+reply to the board, records usage. Returns final output.
export async function runAgent(label, a, { source = "claude" } = {}) {
  const agent = AGENTS[label];
  if (!agent) throw new Error(`Unknown agent: ${label}`);
  const { cmd, args, stdin, promptArg, shell } = agent.build(a);
  const fullPrompt = (a.include_board === false ? "" : TEAM_PREAMBLE(label)) + a.prompt;
  const cwd = a.cwd || process.cwd();
  const runId = `${Date.now()}-${label}`;
  const logFile = join(RUNS, runId + ".log");
  const log = createWriteStream(logFile);

  post(`${source} → ${label}${a.task_type ? ` [${a.task_type}]` : ""}`, a.prompt);
  const started = Date.now();

  const output = await new Promise((resolve) => {
    const child = execFile(cmd, promptArg ? [...args, fullPrompt] : args,
      { cwd, maxBuffer: 1024 * 1024 * 32, timeout: 10 * 60 * 1000, shell: !!shell },
      (err, stdout, stderr) => {
        log.end();
        resolve({ out: err ? `ERROR: ${err.message}\n${stderr}` : stdout || stderr, meta: stderr || "" });
      });
    logEvent({ ev: "start", agent: label, pid: child.pid, cwd, runId, source, task_type: a.task_type || null, prompt: a.prompt.slice(0, 300) });
    child.stdout?.on("data", (d) => log.write(d));
    child.stderr?.on("data", (d) => log.write(d));
    if (stdin != null && child.stdin) child.stdin.write(fullPrompt);
    child.stdin?.end();
  });

  let { out, meta } = output;
  if (label === "agy" && !out.trim()) out = agyLastReply(started - 2000) || "(agy returned no output)";

  const secs = Math.round((Date.now() - started) / 1000);
  const tokMatch = /tokens used[:\s]+([\d,]+)/i.exec(out + "\n" + meta);
  const tokens = tokMatch ? Number(tokMatch[1].replace(/,/g, "")) : null;
  logEvent({ ev: "end", agent: label, runId, secs, tokens, error: out.startsWith("ERROR:") });
  logUsage({ ts: new Date().toISOString(), agent: label, task_type: a.task_type || null, model: a.model || "default", effort: a.effort || "default", secs, tokens, error: out.startsWith("ERROR:"), prompt_chars: a.prompt.length });
  post(label, out.slice(-6000));
  archiveReport({ agent: label, task_type: a.task_type, cwd, prompt: a.prompt, output: out });
  return { output: out, secs, tokens };
}
