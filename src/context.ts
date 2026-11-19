// Builds the context pack an agent gets from get_context: full on first call, deltas afterwards.
import { db, json } from "./db.js";
import { Agent, getRoom, agentsOf, agentById, listDocs, getDoc, unackedFor, unreadCount, claimsOf } from "./core.js";
import { planView, listTasks, approvedPlan } from "./planning.js";

const DOC_LIMIT = 6000;
const PROFILE_PREVIEW = 700;

const cut = (s: string, n: number, hint: string) => (s.length > n ? `${s.slice(0, n)}\n…(truncated — ${hint})` : s);

export function nextAction(a: Agent): string {
  const room = getRoom(a.room_id)!;
  const isLead = room.lead_agent_id === a.id;
  const plan = planView(a.room_id);
  switch (room.phase) {
    case "setup":
      return "The humans are still setting up the room. Read the team docs and your profile. Do not write code yet. You may introduce yourself in the general channel and ask clarifying questions about the requirements.";
    case "planning": {
      if (!plan || plan.status === "approved") {
        return isLead
          ? "YOU ARE THE LEAD. Draft the overall plan NOW with propose_plan: goal, milestones (keys like m1, m2), and one workstream per agent (see Agents below). Base it on /team/requirements.md and /team/architecture.md. " +
            "Do NOT wait for answers to open questions — everyone else is blocked until your draft exists. Make reasonable assumptions, list them under \"Assumptions / open questions\" in the overview, and ask in general in parallel; you can redraft any time with propose_plan."
          : "Wait for the lead agent to draft the plan (use wait_for_messages). Meanwhile share constraints or questions about your area in the general channel.";
      }
      const mine = plan.subplans.find((s: any) => s.agent.toLowerCase() === a.name.toLowerCase());
      const missing = plan.workstreams.filter((w: any) => !plan.subplans.some((s: any) => s.agent.toLowerCase() === w.agent.toLowerCase())).map((w: any) => w.agent);
      const myWs = plan.workstreams.find((w: any) => w.agent.toLowerCase() === a.name.toLowerCase());
      const parts: string[] = [];
      if (plan.decision_note) parts.push(`The humans requested changes: "${plan.decision_note}". Address them (lead: propose_plan; everyone: update your subplan if affected).`);
      if (myWs && !mine) parts.push(`Write your subplan NOW for your workstream ("${myWs.summary}") with propose_subplan: tasks with keys prefixed by your area (e.g. fe-1), acceptance criteria, paths, depends_on (also other agents' task keys), subtasks. Don't wait for answers to open questions: note your assumptions in the summary.`);
      else if (mine) parts.push("Your subplan is in. Review the whole plan (get_plan) and the other subplans; align dependencies and API boundaries with other agents; update with propose_subplan if needed.");
      else parts.push("You have no workstream in this plan. If you should, ask the lead in general.");
      if (isLead) parts.push(missing.length ? `As lead: waiting for subplans from ${missing.join(", ")}. Nudge them if needed.` : "As lead: all subplans are in. Check consistency (get_plan), then call submit_plan_for_review.");
      return parts.join(" ");
    }
    case "plan_review":
      return "The plan is waiting for human approval in the web UI. Do not start coding. Answer questions if humans ask; use wait_for_messages.";
    case "executing": {
      const tasks = listTasks(a.room_id).filter((t: any) => t.owner === a.name && t.status !== "done");
      const active = tasks.find((t: any) => t.status === "in_progress");
      if (active) return `Continue task #${active.number} "${active.title}". Keep subtasks updated; when done open a PR (branch room/${active.number}-<slug>), link_pr, update_task status=review.`;
      const review = tasks.filter((t: any) => t.status === "review");
      const ready = tasks.find((t: any) => t.status === "todo" && !t.blocked_by.length);
      if (ready) return `Claim your next ready task: #${ready.number} "${ready.title}" (claim_task).${review.length ? ` Also watch PR feedback for ${review.map((t: any) => "#" + t.number).join(", ")}.` : ""}`;
      if (review.length) return `Your tasks ${review.map((t: any) => "#" + t.number).join(", ")} are in review. Check get_pr_feedback, fix if needed, otherwise wait_for_messages.`;
      if (tasks.length) return `Your remaining tasks are blocked by others (${tasks.map((t: any) => `#${t.number} ← ${t.blocked_by.map((n: number) => "#" + n).join(",")}`).join("; ")}). Help unblock (ask in general) or wait_for_messages.`;
      return "You have no open tasks. Ask in general whether someone needs help, or propose_plan_change if you see missing work.";
    }
    case "done":
      return "The project is marked done. Only act on explicit requests.";
  }
  return "";
}

function taskLine(t: any) {
  return `#${t.number} [${t.status}] ${t.title} — ${t.owner ? "@" + t.owner : "unassigned"}${t.blocked_by.length ? ` (blocked by ${t.blocked_by.map((n: number) => "#" + n).join(",")})` : ""}${t.pr ? ` PR #${t.pr.number} ${t.pr.state}${t.pr.ci_state ? "/CI " + t.pr.ci_state : ""}` : ""}`;
}

export function myTasksBlock(a: Agent) {
  const tasks = listTasks(a.room_id).filter((t: any) => t.owner === a.name && t.status !== "done");
  if (!tasks.length) return "(none)";
  return tasks.map((t: any) => {
    const subs = t.subtasks.map((s: any) => `    - [${s.done ? "x" : " "}] (id ${s.id}) ${s.title}`).join("\n");
    return [
      taskLine(t),
      t.description ? `    ${t.description.replace(/\n/g, "\n    ")}` : "",
      t.acceptance ? `    Done when: ${t.acceptance}` : "",
      t.paths.length ? `    Paths: ${t.paths.join(", ")}` : "",
      subs,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function ledgerBlock(a: Agent) {
  const items = unackedFor(a);
  if (!items.length) return "";
  return [
    `## ⚠ Ledger entries you must read and ack (${items.length})`,
    ...items.map((l: any) => `- [id ${l.id}] ${l.kind.toUpperCase()}${l.status === "pending" ? " (pending approval)" : ""} by ${l.author}: ${l.title}${l.body ? `\n    ${l.body.slice(0, 1500).replace(/\n/g, "\n    ")}` : ""}`),
    "Adapt your work if needed, then call ack with these ids.",
  ].join("\n");
}

export function buildContext(a: Agent, opts: { full?: boolean } = {}) {
  const room = getRoom(a.room_id)!;
  const full = opts.full || a.ctx_cursor === 0;
  const maxActivity = (db.prepare("SELECT COALESCE(MAX(id),0) m FROM activity WHERE room_id = ?").get(a.room_id) as any).m as number;
  const agents = agentsOf(a.room_id);
  const lead = room.lead_agent_id ? agentById(a.room_id, room.lead_agent_id) : null;
  const out: string[] = [];

  out.push(`# Room "${room.name}" — phase: ${room.phase.toUpperCase()}`);
  out.push(`You are **${a.name}** (${a.agent_type})${a.role_title ? ` — ${a.role_title}` : ""}${lead?.id === a.id ? " — LEAD AGENT" : ""}.`);
  const zone = json<string[]>(a.paths, []);
  if (zone.length) out.push(`Your area (only edit these paths): ${zone.join(", ")}`);
  out.push("", `## ▶ Next action`, nextAction(a));

  const lb = ledgerBlock(a);
  if (lb) out.push("", lb);

  if (full) {
    out.push("", "## Team documents");
    const docs = listDocs(a.room_id);
    for (const d of docs.filter((d) => d.path.startsWith("/team/") && !d.path.startsWith("/team/subagents/"))) {
      const doc = getDoc(a.room_id, d.path)!;
      out.push("", `### ${d.path} (v${d.version})`, cut(doc.content.trim(), DOC_LIMIT, `read_doc ${d.path}`));
    }
    const mine = getDoc(a.room_id, `/agents/${a.name}/profile.md`);
    out.push("", `## Your profile (/agents/${a.name}/profile.md)`, mine ? cut(mine.content.trim(), DOC_LIMIT, "read_doc") : "(missing)");
    out.push("", "## Agents in this room");
    for (const ag of agents) {
      const p = getDoc(a.room_id, `/agents/${ag.name}/profile.md`);
      out.push(`### ${ag.name}${ag.id === a.id ? " (you)" : ""} — ${ag.agent_type}${ag.role_title ? `, ${ag.role_title}` : ""}${ag.id === lead?.id ? ", LEAD" : ""}`,
        `Status: ${ag.status_text || "—"}. Area: ${json<string[]>(ag.paths, []).join(", ") || "—"}`);
      if (ag.id !== a.id && p) out.push(cut(p.content.trim(), PROFILE_PREVIEW, `read_doc /agents/${ag.name}/profile.md`));
    }
    const other = docs.filter((d) => !d.path.startsWith("/team/") || d.path.startsWith("/team/subagents/"));
    out.push("", "## Other docs (read_doc to open)", ...other.map((d) => `- ${d.path} (v${d.version}, by ${d.updated_by})`));
  } else {
    const changes = db.prepare(
      `SELECT actor, summary, type, data FROM activity WHERE room_id = ? AND id > ? AND actor != ? ORDER BY id LIMIT 80`
    ).all(a.room_id, a.ctx_cursor, a.name) as any[];
    out.push("", `## What changed since your last get_context (${changes.length} events)`);
    out.push(changes.length ? changes.map((c) => `- ${c.summary}`).join("\n") : "Nothing new.");
    const docChanges = changes.filter((c) => c.type === "doc").map((c) => json<any>(c.data, {}).path).filter(Boolean);
    const important = [...new Set(docChanges)].filter((p) => p.startsWith("/team/") || p === `/agents/${a.name}/profile.md` || p === "/generated/api-contract.md");
    for (const p of important) {
      const d = getDoc(a.room_id, p);
      if (d) out.push("", `### Updated: ${p} (v${d.version})`, cut(d.content.trim(), DOC_LIMIT, `read_doc ${p}`));
    }
  }

  const plan = room.phase === "executing" || room.phase === "done" ? approvedPlan(a.room_id) : planView(a.room_id);
  if (plan && full) {
    out.push("", `## Plan v${plan.version} (${plan.status})`, `Goal: ${plan.goal}`, "Full plan: get_plan or read_doc /generated/plan.md");
  }

  if (room.phase === "executing" || room.phase === "done") {
    out.push("", "## Your tasks", myTasksBlock(a));
    if (full) {
      const all = listTasks(a.room_id).filter((t: any) => t.owner !== a.name && t.status !== "done");
      out.push("", "## Other open tasks", all.length ? all.map(taskLine).join("\n") : "(none)");
    }
    const claims = claimsOf(a.room_id).filter((c) => c.agent !== a.name);
    if (claims.length) out.push("", "## Paths claimed by others (do not edit)", claims.map((c) => `- ${c.pattern} — ${c.agent}${c.task_number ? ` (#${c.task_number})` : ""}`).join("\n"));
  }

  const unread = unreadCount(a);
  out.push("", unread ? `📬 ${unread} unread message(s) — call read_messages.` : "No unread messages.");
  db.prepare("UPDATE agents SET ctx_cursor = ? WHERE id = ?").run(maxActivity, a.id);
  a.ctx_cursor = maxActivity;
  return out.join("\n");
}
