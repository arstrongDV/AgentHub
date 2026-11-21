// SQLite storage with versioned migrations. One file, WAL mode, safe for concurrent reads.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// Load .env if present (Node 20.12+). Must run before other modules read process.env.
if (fs.existsSync(".env") && typeof (process as any).loadEnvFile === "function") (process as any).loadEnvFile(".env");

const DB_FILE = process.env.DB_FILE || path.resolve("data/agent-rooms.db");
if (DB_FILE !== ":memory:") fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// Built-in SQLite (node:sqlite) — no native build step, works the same on macOS, Linux and Windows.
export const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    github_id TEXT UNIQUE,
    avatar_url TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'setup',
    lead_agent_id TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE TABLE invites (
    code_hash TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_by TEXT,
    used_at TEXT
  );
  CREATE TABLE repos (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    webhook_secret TEXT NOT NULL,
    api_token TEXT,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL,
    UNIQUE (room_id, full_name)
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL COLLATE NOCASE,
    agent_type TEXT NOT NULL,
    role_title TEXT NOT NULL DEFAULT '',
    repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL,
    paths TEXT NOT NULL DEFAULT '[]',
    token_hash TEXT NOT NULL UNIQUE,
    status_text TEXT NOT NULL DEFAULT '',
    last_seen TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    msg_cursor INTEGER NOT NULL DEFAULT 0,
    ctx_cursor INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (room_id, name)
  );
  CREATE TABLE docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (room_id, path)
  );
  CREATE TABLE doc_versions (
    doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, version)
  );
  CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    goal TEXT NOT NULL,
    overview TEXT NOT NULL DEFAULT '',
    milestones TEXT NOT NULL DEFAULT '[]',
    workstreams TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    decision_note TEXT,
    UNIQUE (room_id, version)
  );
  CREATE TABLE plan_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE subplans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    summary TEXT NOT NULL DEFAULT '',
    tasks TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    UNIQUE (plan_id, agent_id)
  );
  CREATE TABLE milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    plan_key TEXT,
    milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
    owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    acceptance TEXT NOT NULL DEFAULT '',
    depends_on TEXT NOT NULL DEFAULT '[]',
    paths TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'todo',
    branch TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (room_id, number)
  );
  CREATE TABLE subtasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    ord INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE task_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE path_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE (agent_id, pattern)
  );
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL,
    author_agent_id TEXT,
    affects TEXT NOT NULL DEFAULT '["all"]',
    status TEXT NOT NULL DEFAULT 'active',
    payload TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE ledger_acks (
    entry_id INTEGER NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    acked_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, agent_id)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    author TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_room ON messages(room_id, id);
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX activity_room ON activity(room_id, id);
  CREATE TABLE prs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    branch TEXT NOT NULL,
    head_sha TEXT,
    state TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    author TEXT,
    files TEXT NOT NULL DEFAULT '[]',
    ci_state TEXT,
    conflicts TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    UNIQUE (repo_id, number)
  );
  CREATE TABLE pr_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    path TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // 2: original files (PDF) behind docs. The doc's content is the text extracted for agents;
  // `version` is the doc version the file was uploaded with (a text-only edit keeps the same file).
  `
  CREATE TABLE doc_files (
    doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    pages INTEGER NOT NULL DEFAULT 0,
    text_chars INTEGER NOT NULL DEFAULT 0,
    data BLOB NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, version)
  );
  `,
];

export function migrate() {
  const current = Number((db.prepare("PRAGMA user_version").get() as any).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
export const now = () => new Date().toISOString();
export const json = <T = any>(s: string | null | undefined, d: T): T => {
  if (!s) return d;
  try { return JSON.parse(s); } catch { return d; }
};
// Transactions with nesting support (inner calls join the outer transaction).
let depth = 0;
export function tx<T>(fn: () => T): T {
  if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
  depth = 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    depth = 0;
  }
}

migrate();
