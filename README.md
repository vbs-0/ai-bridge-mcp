# ai-bridge-mcp

A local bridge so several coding agents on one machine can work as a team: a shared board, a patterns file, a usage ledger, and a dashboard that can watch — and drive — any of them.

Built for a setup with Claude Code as lead, plus Codex, Agy and Freebuff as workers. Everything is files on disk; there is no database and no service to run besides the ones in this repo.

## What it gives you

- **Shared memory** — `board_post` / `board_read` let every agent append to and read one markdown board, so the team has a common conversation log
- **Patterns** — `patterns_note` / `patterns_read` keep reusable lessons in one place instead of in each agent's context
- **Usage ledger** — `usage_stats` reports calls, tokens and errors per agent and task type from `shared/usage.jsonl`
- **Agent spawning** — `runAgent()` launches a fresh headless run of Claude Code, Codex or Agy with the board in its prompt and auto-posts the reply
- **Dashboard** — a single page on :7779 with agent status, live run output, the board feed, usage stats, direct-ask and kill
- **Live terminal** — `term-server.js` wraps a PTY so you can watch and type into an agent's TUI from the browser (:7778), and the same agent can be driven over HTTP

## MCP tools

| Tool | What |
|---|---|
| `board_read` | recent board contents |
| `board_post` | append a message to the board |
| `patterns_read` | the patterns file |
| `patterns_note` | append a pattern |
| `usage_stats` | per-agent call/token/error summary |
| `ask_freebuff` | send a line to the Freebuff terminal |
| `ask_<agent>` | ask a specific teammate and post its reply |

## Run it

```sh
npm install
node index.js            # MCP server over stdio
```

Register `node index.js` as an MCP server in whichever client you use. For the dashboard stack:

```bat
start-all.cmd
```

| Service | Port |
|---|---|
| Board viewer | 7777 |
| Freebuff terminal | 7778 |
| Dashboard | 7779 |

## Configuration

The agent CLIs are looked up on `PATH` by default. Point them elsewhere with environment variables:

| Variable | Default | Used for |
|---|---|---|
| `CLAUDE_CLI` | `claude` | headless Claude Code runs |
| `CODEX_CLI` | `codex` | Codex runs |
| `AGY_CLI` | `agy` | Agy runs |
| `AGY_BRAIN` | `~/.gemini/antigravity-cli/brain` | where Agy keeps transcripts (its `-p` mode prints nothing, so the reply is scraped from here) |

On Windows the npm wrappers are `.cmd` files, so give the full path (e.g. `%APPDATA%\npm\claude.cmd`).

## Files as the database

```
shared/BOARD.md      the team board (append-only markdown)
shared/PATTERNS.md   reusable lessons
shared/usage.jsonl   one JSON line per agent call
shared/events.jsonl  dashboard event feed
shared/runs/         per-run stdout logs
shared/reports/      archived reports, one folder per project
```

The repo ships `BOARD.md` and `PATTERNS.md` as empty templates; the rest is created at runtime and gitignored.

## Notes on this repository

- `node_modules/` was committed in the original working copy (3,800+ files). It is untracked here and ignored; `package-lock.json` pins the four real dependencies (`@modelcontextprotocol/sdk`, `@xterm/headless`, `node-pty`, `ws`).
- Hardcoded absolute paths to the three CLIs and to Agy's transcript folder were replaced with the environment variables above.
- Internal run logs, usage ledgers and per-project reports from the original workspace are not included.

## Limits

- Single machine, single user. There is no authentication on the dashboard or the terminal, so it is meant to run on `localhost` only.
- The Freebuff integration scrapes a TUI; it will break whenever that TUI changes.
- Windows-oriented: `start-all.cmd` and `ensure-stack.cmd` are batch files, though the Node entry points are portable.
