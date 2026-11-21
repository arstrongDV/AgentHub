// Core domain: rooms, members, invites, agents, activity, messages, ledger, docs, path claims.
import { EventEmitter } from "node:events";
import { db, now, json, tx } from "./db.js";
import { sha256, randomToken, newId } from "./auth.js";
import { DEFAULT_DOCS, profileTemplate } from "./templates.js";

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const fail = (msg: string, status = 400): never => { throw new AppError(msg, status); };

export type Actor =
  | { kind: "human"; name: string; userId: string }
  | { kind: "agent"; name: string; agentId: string }
  | { kind: "system" | "github"; name: string };
export const actorId = (a: Actor) =>
  a.kind === "human" ? `user:${a.userId}` : a.kind === "agent" ? `agent:${a.agentId}` : a.kind;

// ---------- events ----------
// "room": something changed in a room (UI refreshes). "wake": specific agents should react (runner).
export const bus = new EventEmitter();
bus.setMaxListeners(0);
export const roomChanged = (roomId: string, type: string) => bus.emit("room", { roomId, type });
export const wake = (roomId: string, agentIds: string[], reason: string, extra: Record<string, any> = {}) => {
  const ids = [...new Set(agentIds.filter(Boolean))];
  if (ids.length) bus.emit("wake", { roomId, agentIds: ids, reason, ...extra });
};

// Live auto-mode runner connections per agent. A "wake" only reaches agents with a runner; an interactive
// session acts only when its human types to it — the UI uses this to tell people who has to nudge whom.
const runners = new Map<string, number>();
export function runnerConnected(roomId: string, agentId: string, delta: 1 | -1) {
  const n = (runners.get(agentId) || 0) + delta;
  if (n > 0) runners.set(agentId, n); else runners.delete(agentId);
  roomChanged(roomId, "agents");
}
export const hasRunner = (agentId: string) => runners.has(agentId);

export function activity(roomId: string, actor: Actor, type: string, summary: string, data?: any) {
  const r = db.prepare("INSERT INTO activity (room_id, actor, type, summary, data, created_at) VALUES (?,?,?,?,?,?)")
    .run(roomId, actor.name, type, summary.slice(0, 500), data ? JSON.stringify(data) : null, now());
  roomChanged(roomId, "activity");
  return Number(r.lastInsertRowid);
}

// ---------- rooms ----------
export type Room = { id: string; name: string; phase: string; lead_agent_id: string | null; created_by: string; created_at: string };
export const PHASES = ["setup", "planning", "plan_review", "executing", "done"] as const;

export function createRoom(userId: string, userName: string, name: string) {
  name = String(name || "").trim().slice(0, 100);
  if (!name) fail("room name is required");
  const id = newId(12); // 96 bits; isolation does not rely on it anyway
  tx(() => {
    db.prepare("INSERT INTO rooms (id, name, created_by, created_at) VALUES (?,?,?,?)").run(id, name, userId, now());
    db.prepare("INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?,?,?,?)").run(id, userId, "owner", now());
    for (const [path, content] of Object.entries(DEFAULT_DOCS)) insertDoc(id, path, content, "system");
  });
  activity(id, { kind: "human", name: userName, userId }, "room", `${userName} created the room`);
  return getRoom(id)!;
}

export const getRoom = (id: string) => db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as Room | undefined;

export function listUserRooms(userId: string) {
  return db.prepare(
    `SELECT r.id, r.name, r.phase, r.created_at, m.role,
       (SELECT COUNT(*) FROM agents a WHERE a.room_id = r.id) AS agents,
       (SELECT COUNT(*) FROM room_members x WHERE x.room_id = r.id) AS members
     FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ? ORDER BY r.created_at DESC`
  ).all(userId);
}

export function roomMembers(roomId: string) {
  return db.prepare(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, m.role, m.joined_at FROM room_members m
     JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.joined_at`
  ).all(roomId) as any[];
}

export function removeMember(roomId: string, userId: string, by: Actor) {
  const m = db.prepare("SELECT role FROM room_members WHERE room_id = ? AND user_id = ?").get(roomId, userId) as any;
  if (!m) fail("not a member", 404);
  if (m.role === "owner") fail("the owner cannot be removed");
  tx(() => {
    db.prepare("DELETE FROM agents WHERE room_id = ? AND owner_user_id = ?").run(roomId, userId);
    db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(roomId, userId);
  });
  activity(roomId, by, "member", `${by.name} removed a member and their agents`);
}

// ---------- invites ----------
export function createInvite(roomId: string, by: Actor & { kind: "human" }, hours = 24) {
  const code = randomToken(12);
  db.prepare("INSERT INTO invites (code_hash, room_id, created_by, expires_at) VALUES (?,?,?,?)")
    .run(sha256(code), roomId, by.userId, new Date(Date.now() + hours * 3600e3).toISOString());
  activity(roomId, by, "invite", `${by.name} created an invite (valid ${hours}h, single use)`);
  return { code, expiresInHours: hours };
}

export function acceptInvite(code: string, userId: string, userName: string) {
  const inv = db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(sha256(String(code || "").trim())) as any;
  if (!inv || inv.used_at || inv.expires_at < now()) fail("invite is invalid, expired or already used", 404);
  const already = db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?").get(inv.room_id, userId);
  tx(() => {
    db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?").run(userId, now(), inv.code_hash);
    if (!already) db.prepare("INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?,?,?,?)").run(inv.room_id, userId, "member", now());
  });
  if (!already) activity(inv.room_id, { kind: "human", name: userName, userId }, "member", `${userName} joined the room`);
  return inv.room_id as string;
}

// ---------- agents ----------
export type Agent = {
  id: string; room_id: string; owner_user_id: string; name: string; agent_type: string; role_title: string;
  repo_id: string | null; paths: string; token_hash: string; status_text: string; last_seen: string | null;
  paused: number; msg_cursor: number; ctx_cursor: number; created_at: string;
};
export const AGENT_TYPES = ["claude", "cursor", "codex", "other"];
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,31}$/;

export const agentByToken = (token: string) =>
  db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(sha256(token)) as Agent | undefined;
export const agentsOf = (roomId: string) =>
  db.prepare("SELECT * FROM agents WHERE room_id = ? ORDER BY created_at").all(roomId) as Agent[];
export const agentById = (roomId: string, id: string) =>
  db.prepare("SELECT * FROM agents WHERE room_id = ? AND id = ?").get(roomId, id) as Agent | undefined;
export const agentByName = (roomId: string, name: string) =>
  db.prepare("SELECT * FROM agents WHERE room_id = ? AND name = ?").get(roomId, String(name || "").replace(/^@/, "")) as Agent | undefined;
export const agentActor = (a: Agent): Actor => ({ kind: "agent", name: a.name, agentId: a.id });

export function publicAgent(a: Agent) {
  const { token_hash, msg_cursor, ctx_cursor, ...rest } = a;
  return { ...rest, paths: json<string[]>(a.paths, []), paused: !!a.paused, auto: hasRunner(a.id) };
}

export function createAgent(roomId: string, owner: Actor & { kind: "human" }, input: any) {
  const name = String(input.name || "").trim();
  if (!NAME_RE.test(name)) fail("agent name: 2–32 chars, letters, digits, - and _, e.g. claude-frontend");
  if (name.toLowerCase() === "all" || name.toLowerCase() === "github" || name.toLowerCase() === "system") fail(`"${name}" is reserved`);
  const type = AGENT_TYPES.includes(input.agentType) ? input.agentType : "other";
  if (agentByName(roomId, name)) fail(`agent "${name}" already exists in this room`);
  const paths = normPaths(input.paths);
  const repoId = input.repoId && db.prepare("SELECT id FROM repos WHERE id = ? AND room_id = ?").get(input.repoId, roomId) ? input.repoId : null;
  const token = `ar_${randomToken(24)}`;
  const id = newId();
  const lastMsg = (db.prepare("SELECT COALESCE(MAX(id),0) m FROM messages WHERE room_id = ?").get(roomId) as any).m;
  tx(() => {
    db.prepare(
      `INSERT INTO agents (id, room_id, owner_user_id, name, agent_type, role_title, repo_id, paths, token_hash, msg_cursor, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, roomId, owner.userId, name, type, String(input.roleTitle || "").slice(0, 120), repoId, JSON.stringify(paths), sha256(token), lastMsg, now());
    const profile = String(input.profile || "").trim() || profileTemplate(name, type, input.roleTitle || "", owner.name, paths);
    // A deleted agent's profile stays in the room, so reusing its name must not collide with it.
    putDoc(roomId, `/agents/${name}/profile.md`, profile, owner.name);
  });
  activity(roomId, owner, "agent", `${owner.name} connected agent ${name} (${type}${input.roleTitle ? ", " + input.roleTitle : ""})`);
  return { agent: publicAgent(agentById(roomId, id)!), token };
}

export function updateAgent(roomId: string, agentId: string, by: Actor, input: any) {
  const a = agentById(roomId, agentId) || fail("agent not found", 404);
  const sets: string[] = [], vals: any[] = [], changes: string[] = [];
  let role: string | undefined, paths: string[] | undefined;
  if (input.roleTitle !== undefined) {
    const v = String(input.roleTitle).trim().slice(0, 120);
    if (v !== a.role_title) { role = v; sets.push("role_title = ?"); vals.push(v); changes.push(`role → ${v || "—"}`); }
  }
  if (input.paths !== undefined) {
    const p = normPaths(input.paths);
    if (JSON.stringify(p) !== a.paths) { paths = p; sets.push("paths = ?"); vals.push(JSON.stringify(p)); changes.push(`area → ${p.join(", ") || "—"}`); }
  }
  if (input.repoId !== undefined) {
    const repo = input.repoId ? (db.prepare("SELECT id, full_name FROM repos WHERE id = ? AND room_id = ?").get(input.repoId, roomId) as any || fail("repository not found in this room")) : null;
    if ((repo?.id || null) !== a.repo_id) { sets.push("repo_id = ?"); vals.push(repo?.id || null); changes.push(`repo → ${repo?.full_name || "—"}`); }
  }
  if (input.paused !== undefined) { sets.push("paused = ?"); vals.push(input.paused ? 1 : 0); }
  if (!sets.length) return publicAgent(a);
  tx(() => {
    db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals, agentId);
    if (role !== undefined || paths !== undefined) syncProfile(roomId, a.name, role, paths, by.name);
  });
  if (input.paused !== undefined) {
    activity(roomId, by, "agent", `${by.name} ${input.paused ? "paused" : "resumed"} agent ${a.name}`);
    bus.emit("pause", { roomId, agentId, paused: !!input.paused });
  }
  if (changes.length) {
    // The activity entry reaches the agent's next get_context delta; the DM reaches it right away
    // (Claude Code hook / runner wake), so it stops working with the old role or area.
    activity(roomId, by, "agent", `${by.name} updated agent ${a.name}: ${changes.join("; ")}`);
    postMessage(roomId, by, dmChannel(actorId(by), `agent:${a.id}`),
      `Your settings changed: ${changes.join("; ")}. From now on only edit files in your area. Call get_context to reload your context.`);
  }
  if (input.paused === undefined && !changes.length) roomChanged(roomId, "agents");
  return publicAgent(agentById(roomId, agentId)!);
}

// Keep the generated "Role" / "Area" lines of an agent's profile in sync. Only those two lines are touched;
// if the owner rewrote the profile without them, it is left as is. Saved as a new version (history kept).
function syncProfile(roomId: string, name: string, role: string | undefined, paths: string[] | undefined, by: string) {
  const path = `/agents/${name}/profile.md`;
  const doc = getDoc(roomId, path);
  if (!doc) return;
  let next = doc.content;
  if (role !== undefined) next = next.replace(/^(- \*\*Role:\*\* ).*$/m, (_, pre) => pre + (role || "(describe the role)"));
  if (paths !== undefined) next = next.replace(/^(- \*\*Area \(paths I own\):\*\* ).*$/m, (_, pre) => pre + (paths.length ? paths.map((p) => `\`${p}\``).join(", ") : "(set paths)"));
  if (next !== doc.content) putDoc(roomId, path, next, by);
}

export function reissueToken(roomId: string, agentId: string, by: Actor) {
  const a = agentById(roomId, agentId) || fail("agent not found", 404);
  const token = `ar_${randomToken(24)}`;
  db.prepare("UPDATE agents SET token_hash = ? WHERE id = ?").run(sha256(token), agentId);
  activity(roomId, by, "agent", `${by.name} reissued the token of ${a.name} (old token revoked)`);
  bus.emit("revoke", { agentId });
  return token;
}

export function deleteAgent(roomId: string, agentId: string, by: Actor) {
  const a = agentById(roomId, agentId) || fail("agent not found", 404);
  tx(() => {
    db.prepare("UPDATE tasks SET owner_agent_id = NULL WHERE owner_agent_id = ?").run(agentId);
    db.prepare("UPDATE rooms SET lead_agent_id = NULL WHERE lead_agent_id = ?").run(agentId);
    db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
  });
  bus.emit("revoke", { agentId });
  activity(roomId, by, "agent", `${by.name} removed agent ${a.name}`);
}

export function touchAgent(a: Agent) {
  db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(now(), a.id);
  roomChanged(a.room_id, "presence");
}
export function setStatus(a: Agent, text: string) {
  db.prepare("UPDATE agents SET status_text = ?, last_seen = ? WHERE id = ?").run(String(text).slice(0, 300), now(), a.id);
  roomChanged(a.room_id, "agents");
}

function normPaths(p: any): string[] {
  const arr = Array.isArray(p) ? p : String(p || "").split(/[,\n]/);
  return arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
}

// ---------- messages / channels ----------
// Channels: "general", "task:<number>", "dm:<participantA>,<participantB>" where participant = agent:<id> | user:<id>
export function dmChannel(a: string, b: string) {
  if (a === b) fail("cannot message yourself");
  return `dm:${[a, b].sort().join(",")}`;
}

export function resolveParticipant(roomId: string, nameOrRef: string): { ref: string; name: string; agentId?: string } {
  const s = String(nameOrRef || "").trim().replace(/^@/, "");
  const ag = agentByName(roomId, s);
  if (ag) return { ref: `agent:${ag.id}`, name: ag.name, agentId: ag.id };
  const user = db.prepare(
    `SELECT u.id, u.display_name, u.username FROM users u JOIN room_members m ON m.user_id = u.id
     WHERE m.room_id = ? AND (u.username = ? COLLATE NOCASE OR u.display_name = ? COLLATE NOCASE)`
  ).get(roomId, s, s) as any;
  if (user) return { ref: `user:${user.id}`, name: user.display_name };
  return fail(`unknown recipient "${s}". Use an agent name, a teammate's username, or channel "general".`);
}

export function postMessage(roomId: string, author: Actor, channel: string, body: string) {
  body = String(body || "").trim();
  if (!body) fail("message is empty");
  if (!(channel === "general" || /^task:\d+$/.test(channel) || /^dm:[a-z]+:[\w-]+,[a-z]+:[\w-]+$/.test(channel))) fail("invalid channel");
  if (channel.startsWith("task:") && !db.prepare("SELECT 1 FROM tasks WHERE room_id = ? AND number = ?").get(roomId, Number(channel.slice(5))))
    fail(`task ${channel.slice(5)} not found`);
  const r = db.prepare("INSERT INTO messages (room_id, channel, author, author_id, author_kind, body, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(roomId, channel, author.name, actorId(author), author.kind, body.slice(0, 20000), now());
  const id = Number(r.lastInsertRowid);
  roomChanged(roomId, "messages");

  // Who should be woken up: DM recipient, task owner, @mentions.
  const targets: string[] = [];
  if (channel.startsWith("dm:")) {
    for (const p of channel.slice(3).split(",")) if (p.startsWith("agent:") && p !== actorId(author)) targets.push(p.slice(6));
  } else if (channel.startsWith("task:")) {
    const t = db.prepare("SELECT owner_agent_id FROM tasks WHERE room_id = ? AND number = ?").get(roomId, Number(channel.slice(5))) as any;
    if (t?.owner_agent_id && `agent:${t.owner_agent_id}` !== actorId(author)) targets.push(t.owner_agent_id);
  }
  for (const m of body.matchAll(/@([a-zA-Z0-9_-]{2,32})/g)) {
    const ag = agentByName(roomId, m[1]);
    if (ag && `agent:${ag.id}` !== actorId(author)) targets.push(ag.id);
  }
  const taskNum = channel.startsWith("task:") ? Number(channel.slice(5)) : null;
  const reason = channel.startsWith("dm:") ? `direct message from ${author.name}: ${body.slice(0, 200)}`
    : taskNum ? `${author.name} wrote in task #${taskNum}: ${body.slice(0, 200)}`
    : `${author.name} mentioned you in general: ${body.slice(0, 200)}`;
  wake(roomId, targets, reason, { channel, task: taskNum });
  return { id, channel };
}

const VISIBLE_SQL = `(m.channel = 'general'
  OR m.channel LIKE 'dm:%' AND (',' || substr(m.channel, 4) || ',') LIKE '%,' || @me || ',%'
  OR m.channel IN (SELECT 'task:' || number FROM tasks WHERE owner_agent_id = @aid)
  OR m.channel IN (SELECT DISTINCT channel FROM messages WHERE room_id = @room AND author_id = @me AND channel LIKE 'task:%'))`;

export function unreadForAgent(a: Agent, limit = 100) {
  return db.prepare(
    `SELECT m.* FROM messages m WHERE m.room_id = @room AND m.id > @cursor AND m.author_id != @me AND ${VISIBLE_SQL}
     ORDER BY m.id LIMIT @limit`
  ).all({ room: a.room_id, cursor: a.msg_cursor, me: `agent:${a.id}`, aid: a.id, limit }) as any[];
}
export function unreadCount(a: Agent) {
  return (db.prepare(
    `SELECT COUNT(*) c FROM messages m WHERE m.room_id = @room AND m.id > @cursor AND m.author_id != @me AND ${VISIBLE_SQL}`
  ).get({ room: a.room_id, cursor: a.msg_cursor, me: `agent:${a.id}`, aid: a.id }) as any).c as number;
}
export function markRead(a: Agent, upTo: number) {
  db.prepare("UPDATE agents SET msg_cursor = MAX(msg_cursor, ?) WHERE id = ?").run(upTo, a.id);
  a.msg_cursor = Math.max(a.msg_cursor, upTo);
}
export function channelHistory(roomId: string, channel: string, limit = 50, before?: number) {
  const rows = db.prepare(
    `SELECT * FROM messages WHERE room_id = ? AND channel = ? ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`
  ).all(...(before ? [roomId, channel, before, limit] : [roomId, channel, limit])) as any[];
  return rows.reverse();
}
export function channelLabel(roomId: string, channel: string, viewerRef?: string) {
  if (!channel.startsWith("dm:")) return channel;
  const names = channel.slice(3).split(",").filter((p) => p !== viewerRef).map((p) => refName(roomId, p));
  return `dm with ${names.join(", ")}`;
}
export function refName(roomId: string, ref: string) {
  if (ref.startsWith("agent:")) return agentById(roomId, ref.slice(6))?.name || "(removed agent)";
  if (ref.startsWith("user:")) return (db.prepare("SELECT display_name FROM users WHERE id = ?").get(ref.slice(5)) as any)?.display_name || "(user)";
  return ref;
}

export function waitForMessage(a: Agent, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (unreadCount(a) > 0) return resolve(true);
    const onWake = (ev: any) => { if (ev.roomId === a.room_id && ev.agentIds.includes(a.id)) done(true); };
    const onRoom = (ev: any) => { if (ev.roomId === a.room_id && ev.type === "messages" && unreadCount(a) > 0) done(true); };
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(v: boolean) {
      clearTimeout(timer); bus.off("wake", onWake); bus.off("room", onRoom); resolve(v);
    }
    bus.on("wake", onWake); bus.on("room", onRoom);
  });
}

// ---------- ledger (shared important context) ----------
export const LEDGER_KINDS = ["decision", "api_change", "env_change", "blocker", "handoff", "milestone", "plan_change"] as const;

export function publish(roomId: string, author: Actor, input: { kind: string; title: string; body?: string; affects?: string[]; status?: string; payload?: any }) {
  if (!LEDGER_KINDS.includes(input.kind as any)) fail(`kind must be one of ${LEDGER_KINDS.join(", ")}`);
  const title = String(input.title || "").trim();
  if (!title) fail("title is required");
  let affects = (input.affects && input.affects.length ? input.affects : ["all"]).map((s) => String(s).replace(/^@/, ""));
  if (!affects.includes("all")) {
    affects = affects.map((n) => (agentByName(roomId, n) || fail(`unknown agent "${n}" in affects`)).name);
  } else affects = ["all"];
  const r = db.prepare(
    `INSERT INTO ledger (room_id, kind, title, body, author, author_agent_id, affects, status, payload, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(roomId, input.kind, title.slice(0, 200), String(input.body || "").slice(0, 20000), author.name,
    author.kind === "agent" ? author.agentId : null, JSON.stringify(affects), input.status || "active",
    input.payload ? JSON.stringify(input.payload) : null, now());
  const id = Number(r.lastInsertRowid);
  activity(roomId, author, "ledger", `${author.name} published ${input.kind}: ${title}`, { ledgerId: id });
  if (!affects.includes("all")) {
    wake(roomId, affects.map((n) => agentByName(roomId, n)?.id || "").filter((x) => x !== (author as any).agentId), `ledger ${input.kind}: ${title}`);
  }
  return id;
}

export function unackedFor(a: Agent) {
  const rows = db.prepare(
    `SELECT l.* FROM ledger l WHERE l.room_id = ? AND l.status != 'rejected'
       AND (l.author_agent_id IS NULL OR l.author_agent_id != ?)
       AND NOT EXISTS (SELECT 1 FROM ledger_acks k WHERE k.entry_id = l.id AND k.agent_id = ?)
       AND l.created_at >= ?
     ORDER BY l.id`
  ).all(a.room_id, a.id, a.id, a.created_at) as any[];
  return rows.filter((l) => {
    const aff = json<string[]>(l.affects, ["all"]);
    return aff.includes("all") || aff.some((n) => n.toLowerCase() === a.name.toLowerCase());
  });
}

export function ack(a: Agent, ids: number[]) {
  const ok: number[] = [];
  for (const id of ids) {
    const l = db.prepare("SELECT id FROM ledger WHERE id = ? AND room_id = ?").get(id, a.room_id);
    if (!l) continue;
    db.prepare("INSERT OR IGNORE INTO ledger_acks (entry_id, agent_id, acked_at) VALUES (?,?,?)").run(id, a.id, now());
    ok.push(id);
  }
  if (ok.length) roomChanged(a.room_id, "ledger");
  return ok;
}

export function ledgerList(roomId: string) {
  const entries = db.prepare("SELECT * FROM ledger WHERE room_id = ? ORDER BY id DESC LIMIT 300").all(roomId) as any[];
  const acks = db.prepare(
    `SELECT k.entry_id, a.name FROM ledger_acks k JOIN agents a ON a.id = k.agent_id JOIN ledger l ON l.id = k.entry_id WHERE l.room_id = ?`
  ).all(roomId) as any[];
  const agents = agentsOf(roomId);
  return entries.map((l) => {
    const affects = json<string[]>(l.affects, ["all"]);
    const ackedBy = acks.filter((k) => k.entry_id === l.id).map((k) => k.name);
    const expected = agents
      .filter((ag) => ag.id !== l.author_agent_id && ag.created_at <= l.created_at)
      .filter((ag) => affects.includes("all") || affects.some((n) => n.toLowerCase() === ag.name.toLowerCase()))
      .map((ag) => ag.name);
    return { ...l, affects, payload: json(l.payload, null), ackedBy, pendingAck: expected.filter((n) => !ackedBy.includes(n)) };
  });
}

// ---------- docs (knowledge base) ----------
// Areas & permissions:
//   /team/**            humans edit, agents read
//   /agents/<name>/**   only the human who owns that agent (or room owner) edits, agents read
//   /generated/**       agents and humans edit
export type Doc = { id: number; room_id: string; path: string; content: string; version: number; updated_by: string; updated_at: string };

export function normDocPath(p: string) {
  let s = "/" + String(p || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  s = s.replace(/\/{2,}/g, "/");
  if (s.split("/").some((seg) => seg === ".." || seg === ".")) fail("invalid path");
  if (!/^\/(team|agents|generated)\/[\w\-./]+$/.test(s)) fail("path must start with /team/, /agents/<name>/ or /generated/ and use letters, digits, - _ . /");
  if (!/\.(md|txt|json|ya?ml|pdf)$/.test(s)) s += ".md";
  return s.slice(0, 200);
}

function insertDoc(roomId: string, path: string, content: string, by: string) {
  const r = db.prepare("INSERT INTO docs (room_id, path, content, version, updated_by, updated_at) VALUES (?,?,?,?,?,?)")
    .run(roomId, path, content, 1, by, now());
  db.prepare("INSERT INTO doc_versions (doc_id, version, content, updated_by, created_at) VALUES (?,?,?,?,?)")
    .run(r.lastInsertRowid, 1, content, by, now());
}

// Like insertDoc, but if the path is taken it saves `content` as the doc's next version (history kept).
// No transaction of its own: callers run it inside theirs.
function putDoc(roomId: string, path: string, content: string, by: string) {
  const existing = getDoc(roomId, path);
  if (!existing) return insertDoc(roomId, path, content, by);
  const version = existing.version + 1;
  db.prepare("UPDATE docs SET content = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(content, version, by, now(), existing.id);
  db.prepare("INSERT INTO doc_versions (doc_id, version, content, updated_by, created_at) VALUES (?,?,?,?,?)").run(existing.id, version, content, by, now());
}

export function canEditDoc(roomId: string, path: string, actor: Actor, memberRole?: string) {
  if (path.startsWith("/generated/")) return true;
  if (actor.kind !== "human") return false;
  if (path.startsWith("/team/")) return true;
  const m = path.match(/^\/agents\/([^/]+)\//);
  if (m) {
    const ag = agentByName(roomId, m[1]);
    if (!ag) return memberRole === "owner";
    return ag.owner_user_id === actor.userId || memberRole === "owner";
  }
  return false;
}

export const listDocs = (roomId: string) =>
  db.prepare(
    `SELECT d.id, d.path, d.version, d.updated_by, d.updated_at, length(d.content) AS size,
       (SELECT f.pages FROM doc_files f WHERE f.doc_id = d.id ORDER BY f.version DESC LIMIT 1) AS pdf_pages
     FROM docs d WHERE d.room_id = ? ORDER BY d.path`
  ).all(roomId) as any[];
export const getDoc = (roomId: string, path: string) =>
  db.prepare("SELECT * FROM docs WHERE room_id = ? AND path = ?").get(roomId, path) as Doc | undefined;

export function writeDoc(roomId: string, path: string, content: string, actor: Actor, opts: { memberRole?: string; baseVersion?: number; mode?: "replace" | "append" } = {}) {
  path = normDocPath(path);
  if (!canEditDoc(roomId, path, actor, opts.memberRole)) {
    fail(actor.kind === "agent"
      ? `agents can only write under /generated/. To change ${path}, ask the humans (send_message) or publish a ledger entry.`
      : `you cannot edit ${path} (agent profiles are edited by the agent's owner)`, 403);
  }
  content = String(content ?? "");
  if (content.length > 300000) fail("document too large (max 300k chars)");
  const existing = getDoc(roomId, path);
  if (!existing && path.endsWith(".pdf")) fail("a .pdf document is created by uploading a PDF file (⇪ in the Team sidebar)");
  if (existing && opts.baseVersion && opts.baseVersion !== existing.version)
    fail(`conflict: ${path} was changed by ${existing.updated_by} (now v${existing.version}, you edited v${opts.baseVersion}). Reload and merge.`, 409);
  const next = opts.mode === "append" && existing ? `${existing.content.replace(/\s+$/, "")}\n\n${content}` : content;
  let version = 1;
  tx(() => {
    if (existing) {
      if (existing.content === next) { version = existing.version; return; }
      version = existing.version + 1;
      db.prepare("UPDATE docs SET content = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(next, version, actor.name, now(), existing.id);
      db.prepare("INSERT INTO doc_versions (doc_id, version, content, updated_by, created_at) VALUES (?,?,?,?,?)").run(existing.id, version, next, actor.name, now());
    } else insertDoc(roomId, path, next, actor.name);
  });
  if (!existing || existing.content !== next) activity(roomId, actor, "doc", `${actor.name} ${existing ? "updated" : "created"} ${path} (v${version})`, { path, version });
  return { path, version };
}

export function deleteDoc(roomId: string, path: string, actor: Actor, memberRole?: string) {
  path = normDocPath(path);
  if (path === "/team/workflow.md") fail("workflow.md cannot be deleted (you can edit it)");
  if (!canEditDoc(roomId, path, actor, memberRole)) fail("not allowed", 403);
  const r = db.prepare("DELETE FROM docs WHERE room_id = ? AND path = ?").run(roomId, path);
  if (!r.changes) fail("doc not found", 404);
  activity(roomId, actor, "doc", `${actor.name} deleted ${path}`, { path });
}

export const docVersions = (roomId: string, path: string) =>
  db.prepare(
    `SELECT v.version, v.updated_by, v.created_at, length(v.content) AS size FROM doc_versions v JOIN docs d ON d.id = v.doc_id
     WHERE d.room_id = ? AND d.path = ? ORDER BY v.version DESC`
  ).all(roomId, path);
export const docVersion = (roomId: string, path: string, version: number) =>
  db.prepare(
    `SELECT v.* FROM doc_versions v JOIN docs d ON d.id = v.doc_id WHERE d.room_id = ? AND d.path = ? AND v.version = ?`
  ).get(roomId, path, version) as any;

export function searchDocs(roomId: string, query: string) {
  const q = String(query || "").toLowerCase().trim();
  if (q.length < 2) fail("query too short");
  const docs = db.prepare("SELECT path, content FROM docs WHERE room_id = ?").all(roomId) as any[];
  const hits: { path: string; line: number; text: string }[] = [];
  for (const d of docs) {
    d.content.split("\n").forEach((line: string, i: number) => {
      if (line.toLowerCase().includes(q) && hits.length < 40) hits.push({ path: d.path, line: i + 1, text: line.trim().slice(0, 200) });
    });
  }
  return hits;
}

// ---------- path claims (soft locks) ----------
const base = (p: string) => p.replace(/^\.?\//, "").replace(/\/?\*.*$/, "").replace(/\/$/, "");
export function pathsOverlap(a: string, b: string) {
  const x = base(a), y = base(b);
  if (!x || !y) return true; // "**" claims everything
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}

export function claimPaths(a: Agent, patterns: string[], taskId: number | null) {
  const others = db.prepare(
    `SELECT c.pattern, ag.name FROM path_claims c JOIN agents ag ON ag.id = c.agent_id WHERE c.room_id = ? AND c.agent_id != ?`
  ).all(a.room_id, a.id) as any[];
  const conflicts: string[] = [];
  const claimed: string[] = [];
  for (const p of patterns.map((s) => String(s).trim()).filter(Boolean)) {
    const hit = others.filter((o) => pathsOverlap(o.pattern, p));
    if (hit.length) { conflicts.push(`${p} overlaps ${hit.map((h) => `${h.pattern} (${h.name})`).join(", ")}`); continue; }
    db.prepare("INSERT OR REPLACE INTO path_claims (room_id, agent_id, pattern, task_id, created_at) VALUES (?,?,?,?,?)").run(a.room_id, a.id, p, taskId, now());
    claimed.push(p);
  }
  if (claimed.length) roomChanged(a.room_id, "claims");
  return { claimed, conflicts };
}
export function releasePaths(a: Agent, patterns?: string[], taskId?: number) {
  let r;
  if (taskId) r = db.prepare("DELETE FROM path_claims WHERE agent_id = ? AND task_id = ?").run(a.id, taskId);
  else if (patterns?.length) {
    r = { changes: 0 };
    for (const p of patterns) r.changes += Number(db.prepare("DELETE FROM path_claims WHERE agent_id = ? AND pattern = ?").run(a.id, p).changes);
  } else r = db.prepare("DELETE FROM path_claims WHERE agent_id = ?").run(a.id);
  if (Number(r.changes)) roomChanged(a.room_id, "claims");
  return Number(r.changes);
}
export const claimsOf = (roomId: string) =>
  db.prepare(
    `SELECT c.pattern, c.task_id, c.created_at, ag.name AS agent, t.number AS task_number FROM path_claims c JOIN agents ag ON ag.id = c.agent_id
     LEFT JOIN tasks t ON t.id = c.task_id WHERE c.room_id = ? ORDER BY ag.name`
  ).all(roomId) as any[];
