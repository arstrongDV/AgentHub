// Plan engine: room phases, collaborative plan + per-agent subplans, human approval, tasks with dependencies.
import { db, now, json, tx } from "./db.js";
import {
  Actor, Agent, fail, activity, roomChanged, wake, getRoom, agentsOf, agentById, agentByName, publish,
  claimPaths, releasePaths, postMessage, writeDoc,
} from "./core.js";

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "review", "done"] as const;

type PlanMilestone = { key: string; title: string };
type Workstream = { agent: string; summary: string };
type SubTaskInput = {
  key: string; title: string; description?: string; acceptance?: string; milestone?: string;
  depends_on?: string[]; paths?: string[]; subtasks?: string[];
};

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/i;

// ---------- phases ----------
export function setLead(roomId: string, agentId: string | null, by: Actor) {
  if (agentId && !agentById(roomId, agentId)) fail("agent not found", 404);
  db.prepare("UPDATE rooms SET lead_agent_id = ? WHERE id = ?").run(agentId, roomId);
  const name = agentId ? agentById(roomId, agentId)!.name : "nobody";
  activity(roomId, by, "phase", `${by.name} set the lead agent: ${name}`);
}

export function startPlanning(roomId: string, by: Actor) {
  const room = getRoom(roomId)!;
  if (!["setup", "executing", "done"].includes(room.phase)) fail(`cannot start planning from phase ${room.phase}`);
  if (!room.lead_agent_id) fail("choose a lead agent first (it drafts the overall plan)");
  if (agentsOf(roomId).length < 1) fail("connect at least one agent first");
  setPhase(roomId, "planning", by);
  const lead = agentById(roomId, room.lead_agent_id)!;
  postMessage(roomId, { kind: "system", name: "system" }, "general",
    `Planning started. @${lead.name} drafts the overall plan with propose_plan now (goal, milestones, one workstream per agent) — ` +
    `don't wait for answers: list open questions as assumptions in the plan. ` +
    `Everyone: read the team docs via get_context, share constraints here, then write your subplan with propose_subplan.`);
  wake(roomId, agentsOf(roomId).map((a) => a.id), "planning started");
}

export function setPhase(roomId: string, phase: string, by: Actor) {
  db.prepare("UPDATE rooms SET phase = ? WHERE id = ?").run(phase, roomId);
  activity(roomId, by, "phase", `Phase → ${phase}`, { phase });
}

// ---------- plans ----------
export function currentPlan(roomId: string) {
  return db.prepare("SELECT * FROM plans WHERE room_id = ? ORDER BY version DESC LIMIT 1").get(roomId) as any;
}
export function approvedPlan(roomId: string) {
  return db.prepare("SELECT * FROM plans WHERE room_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1").get(roomId) as any;
}

export function planView(roomId: string, planId?: number) {
  const plan = planId
    ? db.prepare("SELECT * FROM plans WHERE room_id = ? AND id = ?").get(roomId, planId) as any
    : currentPlan(roomId);
  if (!plan) return null;
  const subplans = db.prepare(
    `SELECT s.*, a.name AS agent FROM subplans s JOIN agents a ON a.id = s.agent_id WHERE s.plan_id = ? ORDER BY a.name`
  ).all(plan.id) as any[];
  const comments = db.prepare("SELECT * FROM plan_comments WHERE plan_id = ? ORDER BY id").all(plan.id);
  const versions = db.prepare("SELECT id, version, status, created_by, created_at FROM plans WHERE room_id = ? ORDER BY version DESC").all(roomId);
  return {
    ...plan,
    milestones: json<PlanMilestone[]>(plan.milestones, []),
    workstreams: json<Workstream[]>(plan.workstreams, []),
    subplans: subplans.map((s) => ({ ...s, tasks: json<SubTaskInput[]>(s.tasks, []) })),
    comments, versions,
  };
}

function requirePhase(roomId: string, ...phases: string[]) {
  const room = getRoom(roomId)!;
  if (!phases.includes(room.phase)) fail(`this is only possible in phase ${phases.join(" or ")} (current phase: ${room.phase})`);
  return room;
}

export function proposePlan(a: Agent, input: { goal: string; overview?: string; milestones: PlanMilestone[]; workstreams: Workstream[] }) {
  const room = requirePhase(a.room_id, "planning");
  if (room.lead_agent_id !== a.id) fail("only the lead agent drafts the overall plan. Use comment_plan to suggest changes, or propose_subplan for your workstream.", 403);
  if (!String(input.goal || "").trim()) fail("goal is required");
  const ms = (input.milestones || []).map((m) => ({ key: String(m.key).trim(), title: String(m.title).trim() }));
  if (!ms.length) fail("at least one milestone is required");
  for (const m of ms) if (!KEY_RE.test(m.key) || !m.title) fail(`invalid milestone ${JSON.stringify(m)} (key: letters/digits/-/_)`);
  if (new Set(ms.map((m) => m.key)).size !== ms.length) fail("milestone keys must be unique");
  const ws = (input.workstreams || []).map((w) => {
    const ag = agentByName(a.room_id, w.agent) || fail(`unknown agent "${w.agent}" in workstreams`);
    return { agent: ag.name, summary: String(w.summary || "").trim() };
  });
  if (!ws.length) fail("at least one workstream is required (one per agent)");

  const prev = currentPlan(a.room_id);
  const version = (prev?.version || 0) + 1;
  const id = tx(() => {
    if (prev && prev.status !== "approved") db.prepare("UPDATE plans SET status = 'superseded' WHERE id = ?").run(prev.id);
    const r = db.prepare(
      `INSERT INTO plans (room_id, version, status, goal, overview, milestones, workstreams, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(a.room_id, version, "draft", input.goal.trim(), String(input.overview || ""), JSON.stringify(ms), JSON.stringify(ws), a.name, now());
    const id = Number(r.lastInsertRowid);
    // carry over subplans from the previous draft so agents only update what changed
    if (prev && prev.status !== "approved") {
      db.prepare(`INSERT INTO subplans (plan_id, agent_id, summary, tasks, updated_at) SELECT ?, agent_id, summary, tasks, updated_at FROM subplans WHERE plan_id = ?`).run(id, prev.id);
    }
    return id;
  });
  activity(a.room_id, { kind: "agent", name: a.name, agentId: a.id }, "plan", `${a.name} proposed plan v${version}: ${input.goal.slice(0, 120)}`, { planId: id });
  renderPlanDoc(a.room_id);
  const others = agentsOf(a.room_id).filter((x) => x.id !== a.id);
  postMessage(a.room_id, { kind: "system", name: "system" }, "general",
    `Plan v${version} drafted by ${a.name}. Each agent with a workstream: write or update your subplan (propose_subplan). Comment with comment_plan.`);
  wake(a.room_id, others.map((x) => x.id), `plan v${version} drafted`);
  return { id, version };
}

export function commentPlan(roomId: string, author: Actor, body: string) {
  const plan = currentPlan(roomId) || fail("there is no plan yet");
  body = String(body || "").trim();
  if (!body) fail("comment is empty");
  db.prepare("INSERT INTO plan_comments (plan_id, author, body, created_at) VALUES (?,?,?,?)").run(plan.id, author.name, body.slice(0, 10000), now());
  activity(roomId, author, "plan", `${author.name} commented on plan v${plan.version}: ${body.slice(0, 140)}`);
  const room = getRoom(roomId)!;
  if (room.lead_agent_id && (author.kind !== "agent" || author.agentId !== room.lead_agent_id)) wake(roomId, [room.lead_agent_id], "plan comment");
}

export function proposeSubplan(a: Agent, input: { summary?: string; tasks: SubTaskInput[] }) {
  requirePhase(a.room_id, "planning");
  const plan = currentPlan(a.room_id);
  if (!plan || plan.status === "approved") fail("there is no draft plan yet — wait for the lead agent's propose_plan");
  const ms = json<PlanMilestone[]>(plan.milestones, []);
  const tasks = (input.tasks || []).map((t) => normalizeTaskInput(t, ms));
  if (!tasks.length) fail("a subplan needs at least one task");
  if (new Set(tasks.map((t) => t.key)).size !== tasks.length) fail("task keys must be unique inside your subplan");
  const clash = db.prepare(`SELECT s.tasks, ag.name FROM subplans s JOIN agents ag ON ag.id = s.agent_id WHERE s.plan_id = ? AND s.agent_id != ?`).all(plan.id, a.id) as any[];
  for (const s of clash) {
    const keys = new Set(json<SubTaskInput[]>(s.tasks, []).map((t) => t.key));
    const dup = tasks.find((t) => keys.has(t.key));
    if (dup) fail(`task key "${dup.key}" is already used by ${s.name}. Prefix keys with your area, e.g. "fe-1".`);
  }
  db.prepare(
    `INSERT INTO subplans (plan_id, agent_id, summary, tasks, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(plan_id, agent_id) DO UPDATE SET summary = excluded.summary, tasks = excluded.tasks, updated_at = excluded.updated_at`
  ).run(plan.id, a.id, String(input.summary || ""), JSON.stringify(tasks), now());
  activity(a.room_id, { kind: "agent", name: a.name, agentId: a.id }, "plan", `${a.name} submitted a subplan for plan v${plan.version} (${tasks.length} tasks)`);
  renderPlanDoc(a.room_id);
  const room = getRoom(a.room_id)!;
  if (room.lead_agent_id && room.lead_agent_id !== a.id) wake(a.room_id, [room.lead_agent_id], `subplan from ${a.name}`);
  return { planVersion: plan.version, tasks: tasks.length };
}

function normalizeTaskInput(t: SubTaskInput, ms: PlanMilestone[]) {
  const key = String(t.key || "").trim();
  if (!KEY_RE.test(key)) fail(`invalid task key "${key}" (letters/digits/-/_, e.g. fe-1)`);
  const title = String(t.title || "").trim();
  if (!title) fail(`task ${key}: title is required`);
  if (t.milestone && !ms.some((m) => m.key === t.milestone)) fail(`task ${key}: unknown milestone "${t.milestone}". Milestones: ${ms.map((m) => m.key).join(", ")}`);
  return {
    key, title: title.slice(0, 200), description: String(t.description || "").slice(0, 8000),
    acceptance: String(t.acceptance || "").slice(0, 4000), milestone: t.milestone || ms[0]?.key,
    depends_on: (t.depends_on || []).map(String), paths: (t.paths || []).map(String).slice(0, 20),
    subtasks: (t.subtasks || []).map(String).filter(Boolean).slice(0, 30),
  };
}

function validatePlanForReview(roomId: string) {
  const plan = planView(roomId)!;
  const problems: string[] = [];
  const allTasks = plan.subplans.flatMap((s: any) => s.tasks.map((t: any) => ({ ...t, agent: s.agent })));
  const keys = new Set(allTasks.map((t: any) => t.key));
  for (const w of plan.workstreams) if (!plan.subplans.some((s: any) => s.agent.toLowerCase() === w.agent.toLowerCase())) problems.push(`workstream of ${w.agent} has no subplan yet`);
  for (const t of allTasks) for (const d of t.depends_on) if (!keys.has(d)) problems.push(`task ${t.key} (${t.agent}) depends on unknown task "${d}"`);
  // cycle detection
  const deps = new Map<string, string[]>(allTasks.map((t: any) => [t.key as string, t.depends_on as string[]]));
  const state = new Map<string, number>();
  const visit = (k: string, stack: string[]): boolean => {
    if (state.get(k) === 1) { problems.push(`dependency cycle: ${[...stack, k].join(" → ")}`); return true; }
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const d of deps.get(k) || []) if (deps.has(d) && visit(d, [...stack, k])) return true;
    state.set(k, 2);
    return false;
  };
  for (const k of deps.keys()) if (visit(k, [])) break;
  return { plan, problems, allTasks };
}

export function submitForReview(a: Agent) {
  const room = requirePhase(a.room_id, "planning");
  if (room.lead_agent_id !== a.id) fail("only the lead agent submits the plan for review", 403);
  const { plan, problems } = validatePlanForReview(a.room_id);
  if (problems.length) fail(`plan is not ready:\n- ${problems.join("\n- ")}`);
  db.prepare("UPDATE plans SET status = 'in_review' WHERE id = ?").run(plan.id);
  setPhase(a.room_id, "plan_review", { kind: "agent", name: a.name, agentId: a.id });
  postMessage(a.room_id, { kind: "system", name: "system" }, "general", `Plan v${plan.version} is waiting for human approval in the web UI.`);
  return { version: plan.version };
}

export function decidePlan(roomId: string, by: Actor, approve: boolean, note = "") {
  requirePhase(roomId, "plan_review");
  const { plan, problems, allTasks } = validatePlanForReview(roomId);
  if (approve && problems.length) fail(`plan has problems:\n- ${problems.join("\n- ")}`);
  if (!approve) {
    tx(() => {
      db.prepare("UPDATE plans SET status = 'draft', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(by.name, now(), note, plan.id);
      if (note) db.prepare("INSERT INTO plan_comments (plan_id, author, body, created_at) VALUES (?,?,?,?)").run(plan.id, by.name, `Changes requested: ${note}`, now());
    });
    setPhase(roomId, "planning", by);
    postMessage(roomId, { kind: "system", name: "system" }, "general", `${by.name} requested changes to plan v${plan.version}: ${note || "(see comments)"}`);
    wake(roomId, agentsOf(roomId).map((x) => x.id), "plan changes requested");
    return { approved: false };
  }
  tx(() => {
    db.prepare("UPDATE plans SET status = 'superseded' WHERE room_id = ? AND status = 'approved'").run(roomId);
    db.prepare("UPDATE plans SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(by.name, now(), note, plan.id);
    materialize(roomId, plan, allTasks, by.name);
  });
  setPhase(roomId, "executing", by);
  publish(roomId, by, { kind: "milestone", title: `Plan v${plan.version} approved — start executing`, body: `Goal: ${plan.goal}\n\n${note}`.trim() });
  renderPlanDoc(roomId);
  wake(roomId, agentsOf(roomId).map((x) => x.id), "plan approved, start working");
  return { approved: true };
}

function materialize(roomId: string, plan: any, allTasks: any[], by: string) {
  const msIds = new Map<string, number>();
  plan.milestones.forEach((m: PlanMilestone, i: number) => {
    const r = db.prepare("INSERT INTO milestones (room_id, plan_id, key, title, ord) VALUES (?,?,?,?,?)").run(roomId, plan.id, m.key, m.title, i);
    msIds.set(m.key, Number(r.lastInsertRowid));
  });
  const keyToNumber = new Map<string, number>();
  // tasks from an earlier approved plan keep their numbers when the key matches
  const existing = db.prepare("SELECT number, plan_key FROM tasks WHERE room_id = ? AND plan_key IS NOT NULL").all(roomId) as any[];
  for (const e of existing) keyToNumber.set(e.plan_key, e.number);
  let next = nextTaskNumber(roomId);
  for (const t of allTasks) if (!keyToNumber.has(t.key)) keyToNumber.set(t.key, next++);
  for (const t of allTasks) {
    const ag = agentByName(roomId, t.agent)!;
    const number = keyToNumber.get(t.key)!;
    const deps = t.depends_on.map((d: string) => keyToNumber.get(d)).filter(Boolean);
    const exists = db.prepare("SELECT id FROM tasks WHERE room_id = ? AND number = ?").get(roomId, number) as any;
    if (exists) {
      db.prepare(`UPDATE tasks SET title=?, description=?, acceptance=?, depends_on=?, paths=?, milestone_id=?, owner_agent_id=?, updated_at=? WHERE id=?`)
        .run(t.title, t.description, t.acceptance, JSON.stringify(deps), JSON.stringify(t.paths), msIds.get(t.milestone) || null, ag.id, now(), exists.id);
      continue;
    }
    const r = db.prepare(
      `INSERT INTO tasks (room_id, number, plan_key, milestone_id, owner_agent_id, title, description, acceptance, depends_on, paths, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(roomId, number, t.key, msIds.get(t.milestone) || null, ag.id, t.title, t.description, t.acceptance,
      JSON.stringify(deps), JSON.stringify(t.paths), "todo", by, now(), now());
    t.subtasks.forEach((s: string, i: number) =>
      db.prepare("INSERT INTO subtasks (task_id, title, ord) VALUES (?,?,?)").run(r.lastInsertRowid, s, i));
  }
  roomChanged(roomId, "tasks");
}

// Executing phase: changes to the plan need human approval. Stored as a pending ledger entry.
export function proposePlanChange(a: Agent, input: { title: string; rationale: string; new_tasks?: (SubTaskInput & { owner?: string })[] }) {
  requirePhase(a.room_id, "executing");
  const plan = approvedPlan(a.room_id) || fail("no approved plan");
  const ms = json<PlanMilestone[]>(plan.milestones, []);
  const tasks = (input.new_tasks || []).map((t) => {
    const n = normalizeTaskInput(t, ms);
    const owner = t.owner ? (agentByName(a.room_id, t.owner) || fail(`unknown owner "${t.owner}"`)).name : a.name;
    for (const d of n.depends_on) if (!/^#?\d+$/.test(d)) fail(`task ${n.key}: in plan changes depends_on uses existing task numbers like "#4"`);
    return { ...n, owner };
  });
  const id = publish(a.room_id, { kind: "agent", name: a.name, agentId: a.id }, {
    kind: "plan_change", title: input.title, body: input.rationale, status: "pending", payload: { tasks },
  });
  return { ledgerId: id, status: "pending human approval" };
}

export function decidePlanChange(roomId: string, ledgerId: number, by: Actor, approve: boolean) {
  const l = db.prepare("SELECT * FROM ledger WHERE id = ? AND room_id = ? AND kind = 'plan_change'").get(ledgerId, roomId) as any;
  if (!l) fail("plan change not found", 404);
  if (l.status !== "pending") fail(`already ${l.status}`);
  const created: number[] = [];
  tx(() => {
    db.prepare("UPDATE ledger SET status = ? WHERE id = ?").run(approve ? "approved" : "rejected", ledgerId);
    if (approve) {
      const plan = approvedPlan(roomId);
      for (const t of json<any>(l.payload, { tasks: [] }).tasks) {
        const owner = agentByName(roomId, t.owner);
        const ms = plan ? db.prepare("SELECT id FROM milestones WHERE plan_id = ? AND key = ?").get(plan.id, t.milestone) as any : null;
        created.push(insertTask(roomId, {
          title: t.title, description: t.description, acceptance: t.acceptance, ownerAgentId: owner?.id || null,
          dependsOn: t.depends_on.map((d: string) => Number(d.replace("#", ""))), paths: t.paths, subtasks: t.subtasks,
          milestoneId: ms?.id || null, planKey: t.key,
        }, by.name));
      }
    }
  });
  activity(roomId, by, "plan", `${by.name} ${approve ? "approved" : "rejected"} plan change: ${l.title}${created.length ? ` (tasks ${created.map((n) => "#" + n).join(", ")})` : ""}`);
  if (l.author_agent_id) wake(roomId, [l.author_agent_id], `plan change ${approve ? "approved" : "rejected"}`);
  renderPlanDoc(roomId);
  return { created };
}

// ---------- tasks ----------
export const nextTaskNumber = (roomId: string) =>
  ((db.prepare("SELECT COALESCE(MAX(number),0) n FROM tasks WHERE room_id = ?").get(roomId) as any).n as number) + 1;

function insertTask(roomId: string, t: { title: string; description?: string; acceptance?: string; ownerAgentId: string | null; dependsOn?: number[]; paths?: string[]; subtasks?: string[]; milestoneId?: number | null; planKey?: string | null }, by: string) {
  for (const d of t.dependsOn || []) if (!db.prepare("SELECT 1 FROM tasks WHERE room_id = ? AND number = ?").get(roomId, d)) fail(`dependency #${d} does not exist`);
  const number = nextTaskNumber(roomId);
  const r = db.prepare(
    `INSERT INTO tasks (room_id, number, plan_key, milestone_id, owner_agent_id, title, description, acceptance, depends_on, paths, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(roomId, number, t.planKey || null, t.milestoneId || null, t.ownerAgentId, String(t.title).slice(0, 200), String(t.description || "").slice(0, 8000),
    String(t.acceptance || "").slice(0, 4000), JSON.stringify(t.dependsOn || []), JSON.stringify(t.paths || []), "todo", by, now(), now());
  (t.subtasks || []).forEach((s, i) => db.prepare("INSERT INTO subtasks (task_id, title, ord) VALUES (?,?,?)").run(r.lastInsertRowid, s, i));
  roomChanged(roomId, "tasks");
  return number;
}

export function createTask(roomId: string, by: Actor, input: any) {
  const title = String(input.title || "").trim();
  if (!title) fail("title is required");
  const room = getRoom(roomId)!;
  if (by.kind === "agent" && room.phase !== "executing") fail("during planning, tasks go into your subplan (propose_subplan)");
  const owner = input.owner ? (agentByName(roomId, input.owner) || fail(`unknown agent "${input.owner}"`)) : null;
  const plan = approvedPlan(roomId);
  const ms = input.milestone && plan ? db.prepare("SELECT id FROM milestones WHERE plan_id = ? AND key = ?").get(plan.id, input.milestone) as any : null;
  const number = insertTask(roomId, {
    title, description: input.description, acceptance: input.acceptance, ownerAgentId: owner?.id || null,
    dependsOn: (input.depends_on || []).map((d: any) => Number(String(d).replace("#", ""))), paths: input.paths, subtasks: input.subtasks,
    milestoneId: ms?.id || null,
  }, by.name);
  activity(roomId, by, "task", `${by.name} created task #${number} "${title}"${owner ? ` for ${owner.name}` : ""}`, { task: number });
  if (owner && !(by.kind === "agent" && by.agentId === owner.id)) wake(roomId, [owner.id], `task #${number} assigned to you`, { task: number });
  return number;
}

export function getTaskByNumber(roomId: string, number: number) {
  return db.prepare("SELECT * FROM tasks WHERE room_id = ? AND number = ?").get(roomId, Number(String(number).replace("#", ""))) as any;
}

export function taskView(roomId: string, t: any) {
  if (!t) return null;
  const deps = json<number[]>(t.depends_on, []);
  const depRows = deps.length
    ? db.prepare(`SELECT number, status, title FROM tasks WHERE room_id = ? AND number IN (${deps.map(() => "?").join(",")})`).all(roomId, ...deps) as any[]
    : [];
  const owner = t.owner_agent_id ? agentById(roomId, t.owner_agent_id) : null;
  const ms = t.milestone_id ? db.prepare("SELECT key, title FROM milestones WHERE id = ?").get(t.milestone_id) as any : null;
  return {
    ...t,
    depends_on: deps, paths: json<string[]>(t.paths, []),
    owner: owner?.name || null,
    milestone: ms,
    blocked_by: depRows.filter((d) => d.status !== "done").map((d) => d.number),
    deps: depRows,
    subtasks: db.prepare("SELECT id, title, done FROM subtasks WHERE task_id = ? ORDER BY ord, id").all(t.id),
    notes: db.prepare("SELECT author, body, created_at FROM task_notes WHERE task_id = ? ORDER BY id").all(t.id),
    pr: t.pr_number ? db.prepare("SELECT number, url, state, ci_state, title FROM prs WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1").get(t.id) : null,
  };
}

export function listTasks(roomId: string) {
  return (db.prepare("SELECT * FROM tasks WHERE room_id = ? ORDER BY number").all(roomId) as any[]).map((t) => taskView(roomId, t));
}

export function milestonesOf(roomId: string) {
  const plan = approvedPlan(roomId);
  if (!plan) return [];
  return db.prepare("SELECT id, key, title, ord FROM milestones WHERE plan_id = ? ORDER BY ord").all(plan.id) as any[];
}

export function claimTask(a: Agent, number: number, force = false) {
  const room = getRoom(a.room_id)!;
  if (room.phase !== "executing") fail(`tasks can be claimed only in the executing phase (now: ${room.phase})`);
  const t = getTaskByNumber(a.room_id, number) || fail(`task #${number} not found`, 404);
  if (t.status === "done") fail(`task #${number} is already done`);
  if (t.owner_agent_id && t.owner_agent_id !== a.id && !force) {
    const o = agentById(a.room_id, t.owner_agent_id);
    fail(`task #${number} belongs to ${o?.name}. Message them, or use force=true only if you agreed.`);
  }
  const v = taskView(a.room_id, t)!;
  if (v.blocked_by.length) fail(`task #${number} is blocked by unfinished ${v.blocked_by.map((n: number) => "#" + n).join(", ")}. Pick another task or help finish those.`);
  const actor: Actor = { kind: "agent", name: a.name, agentId: a.id };
  db.prepare("UPDATE tasks SET owner_agent_id = ?, status = 'in_progress', updated_at = ? WHERE id = ?").run(a.id, now(), t.id);
  const claims = v.paths.length ? claimPaths(a, v.paths, t.id) : { claimed: [], conflicts: [] };
  db.prepare("UPDATE agents SET status_text = ? WHERE id = ?").run(`working on #${number}: ${t.title}`, a.id);
  activity(a.room_id, actor, "task", `${a.name} started #${number} "${t.title}"`, { task: number });
  return { task: taskView(a.room_id, getTaskByNumber(a.room_id, number)), claims };
}

export function updateTask(roomId: string, by: Actor, number: number, input: any) {
  const t = getTaskByNumber(roomId, number) || fail(`task #${number} not found`, 404);
  const changes: string[] = [];
  const sets: string[] = [], vals: any[] = [];
  if (input.status !== undefined && input.status !== t.status) {
    if (!TASK_STATUSES.includes(input.status)) fail(`status must be one of ${TASK_STATUSES.join(", ")}`);
    if (input.status === "in_progress" && by.kind === "agent") {
      const v = taskView(roomId, t)!;
      if (v.blocked_by.length) fail(`blocked by ${v.blocked_by.map((n: number) => "#" + n).join(", ")}`);
    }
    sets.push("status = ?"); vals.push(input.status); changes.push(`${t.status} → ${input.status}`);
  }
  if (input.owner !== undefined) {
    const o = input.owner ? (agentByName(roomId, input.owner) || fail(`unknown agent "${input.owner}"`)) : null;
    if ((o?.id || null) !== t.owner_agent_id) { sets.push("owner_agent_id = ?"); vals.push(o?.id || null); changes.push(o ? `assigned to ${o.name}` : "unassigned"); if (o) wake(roomId, [o.id], `task #${number} assigned to you`, { task: number }); }
  }
  for (const [k, col] of [["title", "title"], ["description", "description"], ["acceptance", "acceptance"]] as const) {
    if (input[k] !== undefined && input[k] !== t[col]) { sets.push(`${col} = ?`); vals.push(String(input[k])); changes.push(`${k} updated`); }
  }
  if (input.paths !== undefined) { sets.push("paths = ?"); vals.push(JSON.stringify(input.paths)); changes.push("paths updated"); }
  if (input.depends_on !== undefined) {
    const deps = input.depends_on.map((d: any) => Number(String(d).replace("#", "")));
    for (const d of deps) if (d === t.number || !getTaskByNumber(roomId, d)) fail(`invalid dependency #${d}`);
    sets.push("depends_on = ?"); vals.push(JSON.stringify(deps)); changes.push("dependencies updated");
  }
  if (input.note) { db.prepare("INSERT INTO task_notes (task_id, author, body, created_at) VALUES (?,?,?,?)").run(t.id, by.name, String(input.note).slice(0, 8000), now()); changes.push(`note: ${String(input.note).slice(0, 120)}`); }
  if (sets.length) { sets.push("updated_at = ?"); vals.push(now()); db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals, t.id); }
  if (!changes.length) return taskView(roomId, t);
  activity(roomId, by, "task", `${by.name} updated #${number}: ${changes.join("; ")}`, { task: number });
  if (input.status === "done" && t.status !== "done") onTaskDone(roomId, getTaskByNumber(roomId, number), by);
  if (by.kind === "human" && t.owner_agent_id && input.note) wake(roomId, [t.owner_agent_id], `${by.name} commented on task #${number}`, { task: number });
  return taskView(roomId, getTaskByNumber(roomId, number));
}

export function onTaskDone(roomId: string, t: any, by: Actor) {
  if (t.owner_agent_id) {
    const owner = agentById(roomId, t.owner_agent_id);
    if (owner) {
      releasePaths(owner, undefined, t.id);
      if (owner.status_text.includes(`#${t.number}`)) db.prepare("UPDATE agents SET status_text = 'idle' WHERE id = ?").run(owner.id);
    }
  }
  // wake owners of tasks that just became unblocked
  const dependents = (db.prepare("SELECT * FROM tasks WHERE room_id = ? AND status != 'done'").all(roomId) as any[])
    .filter((x) => json<number[]>(x.depends_on, []).includes(t.number));
  for (const d of dependents) {
    const v = taskView(roomId, d)!;
    if (!v.blocked_by.length && d.owner_agent_id) {
      wake(roomId, [d.owner_agent_id], `task #${d.number} is unblocked (#${t.number} done)`, { task: d.number });
      activity(roomId, { kind: "system", name: "system" }, "task", `#${d.number} "${d.title}" is unblocked`, { task: d.number });
    }
  }
  // milestone complete?
  if (t.milestone_id) {
    const open = (db.prepare("SELECT COUNT(*) c FROM tasks WHERE milestone_id = ? AND status != 'done'").get(t.milestone_id) as any).c;
    if (!open) {
      const ms = db.prepare("SELECT title FROM milestones WHERE id = ?").get(t.milestone_id) as any;
      publish(roomId, { kind: "system", name: "system" }, { kind: "milestone", title: `Milestone done: ${ms.title}` });
    }
  }
  roomChanged(roomId, "tasks");
}

export function deleteTask(roomId: string, by: Actor, number: number) {
  const t = getTaskByNumber(roomId, number) || fail("task not found", 404);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
  activity(roomId, by, "task", `${by.name} deleted task #${number} "${t.title}"`);
}

export function addSubtasks(roomId: string, by: Actor, number: number, titles: string[]) {
  const t = getTaskByNumber(roomId, number) || fail("task not found", 404);
  const max = (db.prepare("SELECT COALESCE(MAX(ord),0) m FROM subtasks WHERE task_id = ?").get(t.id) as any).m;
  titles.filter(Boolean).forEach((s, i) => db.prepare("INSERT INTO subtasks (task_id, title, ord) VALUES (?,?,?)").run(t.id, String(s).slice(0, 300), max + 1 + i));
  roomChanged(roomId, "tasks");
  return taskView(roomId, t);
}

export function checkSubtask(roomId: string, by: Actor, subtaskId: number, done: boolean) {
  const s = db.prepare("SELECT s.*, t.number, t.room_id FROM subtasks s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?").get(subtaskId) as any;
  if (!s || s.room_id !== roomId) fail("subtask not found", 404);
  db.prepare("UPDATE subtasks SET done = ? WHERE id = ?").run(done ? 1 : 0, subtaskId);
  roomChanged(roomId, "tasks");
  return { task: s.number, subtask: s.title, done };
}

// ---------- rendered plan doc (so humans and agents can read it as a file) ----------
export function renderPlanDoc(roomId: string) {
  const p = planView(roomId);
  if (!p) return;
  const lines = [`# Plan v${p.version} (${p.status})`, "", `**Goal:** ${p.goal}`, "", p.overview || "", "", "## Milestones"];
  for (const m of p.milestones) lines.push(`- \`${m.key}\` ${m.title}`);
  lines.push("", "## Workstreams");
  for (const w of p.workstreams) {
    lines.push(`### ${w.agent}`, w.summary || "");
    const sp = p.subplans.find((s: any) => s.agent.toLowerCase() === w.agent.toLowerCase());
    if (!sp) { lines.push("_subplan pending_", ""); continue; }
    if (sp.summary) lines.push(sp.summary);
    for (const t of sp.tasks) {
      lines.push(`- **${t.key}** ${t.title} _(milestone ${t.milestone}${t.depends_on.length ? `, after ${t.depends_on.join(", ")}` : ""})_`);
      if (t.acceptance) lines.push(`  - Done when: ${t.acceptance}`);
      for (const s of t.subtasks) lines.push(`  - [ ] ${s}`);
    }
    lines.push("");
  }
  writeDoc(roomId, "/generated/plan.md", lines.join("\n"), { kind: "system", name: "system" });
}
