#!/usr/bin/env node
// agent-rooms runner v2 — wakes your coding agent (headless) when the room needs it.
// Zero dependencies, Node 18+.
//
//   node room-runner.mjs --hub https://hub --token ar_xxx --agent claude|codex|cursor [--cwd .]
//
// What wakes the agent: direct messages, messages in its task channels, @mentions, ledger entries that
// name it, tasks assigned/unblocked, PR review/CI feedback, phase changes. Nothing else.
//
// Options:
//   --cwd <dir>          project folder (default: current)
//   --bin <cli>          override CLI binary (e.g. "agent" for newer Cursor CLI)
//   --max-per-hour <n>   rate limit of agent runs (default 12)
//   --debounce <ms>      batch events for this long before launching (default 5000)
//   --no-resume          don't resume Claude Code sessions per task
//   --dry-run            print what would run
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const HUB = String(opt("hub", process.env.ROOM_HUB || "")).replace(/\/$/, "");
const TOKEN = opt("token", process.env.ROOM_TOKEN);
const AGENT = opt("agent", "claude");
const CWD = path.resolve(opt("cwd", "."));
const BIN = opt("bin", { claude: "claude", codex: "codex", cursor: "cursor-agent" }[AGENT]);
const MAX_PER_HOUR = Number(opt("max-per-hour", 12));
const DEBOUNCE = Number(opt("debounce", 5000));
const DRY = flag("dry-run");
const RESUME = !flag("no-resume");
const IS_WIN = process.platform === "win32";
const STATE_FILE = path.join(CWD, ".room-runner.json");

if (!HUB || !TOKEN || !BIN) {
  console.error("Usage: node room-runner.mjs --hub <url> --token <agent-token> --agent claude|codex|cursor [--cwd .]");
  process.exit(1);
}

const log = (...a) => console.log(`\x1b[36m[room ${new Date().toLocaleTimeString()}]\x1b[0m`, ...a);
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { sessions: {} }; } })();
const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {} };

let paused = false, running = false, timer = null;
let queue = [];
const runs = [];

// Characters that break shells (cmd.exe in particular) are stripped from dynamic text.
const clean = (s) => String(s).replace(/[\r\n"'`%^&|<>$\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);

function schedule(reason, task = null) {
  queue.push({ reason: clean(reason), task });
  clearTimeout(timer);
  timer = setTimeout(run, DEBOUNCE);
}

function buildPrompt(items) {
  const tasks = [...new Set(items.map((i) => i.task).filter(Boolean))];
  return `You were woken up by your team room: ${items.map((i) => i.reason).join(" | ")}. ` +
    `Use the room MCP tools: call get_context first (ack ledger entries after adapting), then read_messages, then act according to the Next action and /team/workflow.md. ` +
    (tasks.length ? `Relevant task(s): ${tasks.map((t) => "#" + t).join(", ")}. ` : "") +
    `Reply to whoever needs an answer with send_message. Keep tasks, subtasks and status updated. Stop when there is nothing left to do right now.`;
}

function command(prompt, sessionId) {
  switch (AGENT) {
    case "claude": // prompt via stdin: no quoting problems on any OS
      return { args: ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "mcp__room", ...(sessionId ? ["--resume", sessionId] : [])], stdin: prompt, json: true };
    case "codex":
      return { args: ["exec", "--full-auto", prompt] };
    case "cursor":
      return { args: ["-p", "--force", prompt] };
    default:
      console.error(`Unknown --agent ${AGENT}`); process.exit(1);
  }
}

function exec(cmd) {
  return new Promise((resolve) => {
    const args = IS_WIN ? cmd.args.map((a) => `"${a.replace(/"/g, '""')}"`) : cmd.args;
    const child = spawn(BIN, args, { cwd: CWD, shell: IS_WIN, stdio: [cmd.stdin ? "pipe" : "ignore", cmd.json ? "pipe" : "inherit", "inherit"] });
    let out = "";
    if (cmd.json) child.stdout.on("data", (d) => (out += d));
    if (cmd.stdin) { child.stdin.write(cmd.stdin); child.stdin.end(); }
    child.on("error", (e) => resolve({ code: -1, out, error: e.message }));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

async function run() {
  if (running || !queue.length) return;
  if (paused) { log(`paused in the room — ${queue.length} event(s) kept until resumed`); return; }
  const hourAgo = Date.now() - 3600e3;
  while (runs.length && runs[0] < hourAgo) runs.shift();
  if (runs.length >= MAX_PER_HOUR) {
    const wait = runs[0] + 3600e3 - Date.now() + 1000;
    log(`rate limit (${MAX_PER_HOUR}/h) reached, next run in ${Math.ceil(wait / 60000)} min`);
    clearTimeout(timer); timer = setTimeout(run, wait);
    return;
  }
  const items = queue.splice(0);
  running = true; runs.push(Date.now());
  const key = items.find((i) => i.task)?.task ? `task-${items.find((i) => i.task).task}` : "room";
  const prompt = buildPrompt(items);
  const sessionId = AGENT === "claude" && RESUME ? state.sessions[key] : null;
  const cmd = command(prompt, sessionId);
  log(`→ ${BIN} (${key}${sessionId ? ", resuming session" : ""}): ${items.map((i) => i.reason).join(" | ").slice(0, 160)}`);
  if (DRY) { console.log({ bin: BIN, args: cmd.args, stdin: cmd.stdin }); running = false; return; }
  let r = await exec(cmd);
  if (r.code !== 0 && sessionId) { // stale session: retry fresh
    log("resume failed, starting a fresh session");
    delete state.sessions[key];
    r = await exec(command(prompt, null));
  }
  if (r.error) log(`could not start ${BIN}: ${r.error}. Is it installed and on PATH? (--bin to override)`);
  if (cmd.json && r.out) {
    try {
      const j = JSON.parse(r.out.trim().split("\n").pop());
      if (j.session_id) { state.sessions[key] = j.session_id; saveState(); }
      console.log(String(j.result || "").trim());
    } catch { process.stdout.write(r.out); }
  }
  log(`${BIN} finished (exit ${r.code})`);
  running = false;
  if (queue.length) { clearTimeout(timer); timer = setTimeout(run, 1500); }
}

async function listen() {
  let backoff = 1000;
  for (;;) {
    try {
      const res = await fetch(`${HUB}/api/agent/${TOKEN}/events`, { headers: { Accept: "text/event-stream" } });
      if (res.status === 401) { console.error("Token is invalid or was revoked. Get a new one in the room (⚙ next to your agent)."); process.exit(1); }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      backoff = 1000;
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
          buf = buf.slice(i + 2);
          if (!line) continue;
          const ev = JSON.parse(line.slice(5));
          if (ev.type === "hello") {
            paused = ev.paused;
            log(`connected to "${ev.room}" as ${ev.you} · phase ${ev.phase}${paused ? " · PAUSED" : ""} · folder ${CWD}`);
            if (ev.pending) schedule(`${ev.pending} pending message(s)/ledger entries`);
          } else if (ev.type === "wake") {
            log(`wake: ${ev.reason}`);
            schedule(ev.reason, ev.task);
          } else if (ev.type === "paused") { paused = true; log("agent paused from the web UI"); }
          else if (ev.type === "resumed") { paused = false; log("agent resumed"); if (queue.length) schedule("resumed"); }
          else if (ev.type === "revoked") { console.error("Token revoked. Exiting."); process.exit(1); }
        }
      }
      throw new Error("stream closed");
    } catch (e) {
      log(`disconnected (${e.message}), reconnecting in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

log(`runner v2 · agent ${AGENT} (${BIN}) · max ${MAX_PER_HOUR} runs/h${AGENT === "claude" && RESUME ? " · session resume per task" : ""}`);
listen();
