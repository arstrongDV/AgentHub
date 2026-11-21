// MCP server for one agent (identified by its token). Tools, prompts (slash commands) and resources (docs).
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as C from "./core.js";
import * as P from "./planning.js";
import * as G from "./github.js";
import * as F from "./files.js";
import { buildContext, myTasksBlock } from "./context.js";

type A = C.Agent;

const READ_CHUNK = 40000; // keeps one read_doc result well under clients' tool-output limits

export function buildMcpServer(agent: A, hubUrl: string) {
  const roomId = agent.room_id;
  const me: C.Actor = C.agentActor(agent);
  const room = C.getRoom(roomId)!;
  const server = new McpServer(
    { name: "agent-rooms", version: "2.0.0" },
    {
      instructions:
        `You are "${agent.name}" in the team room "${room.name}". Several AI agents and humans build one project together through this room. ` +
        `ALWAYS call get_context first and follow its "Next action". Follow /team/workflow.md: plan together, claim tasks, stay in your area, ` +
        `publish only important shared facts to the ledger and ack entries shown to you, communicate concretely.`,
    }
  );

  // Footer appended to every result: keeps agents aware of new messages / ledger items without polling.
  const footer = () => {
    const a = C.agentById(roomId, agent.id);
    if (!a) return "";
    const unread = C.unreadCount(a);
    const ledger = C.unackedFor(a).length;
    const bits = [];
    if (unread) bits.push(`📬 ${unread} unread message(s) → read_messages`);
    if (ledger) bits.push(`⚠ ${ledger} ledger entr${ledger === 1 ? "y" : "ies"} to ack → get_context`);
    return bits.length ? `\n\n${bits.join(" · ")}` : "";
  };
  const wrap = <T,>(fn: (args: T, a: A) => any) => async (args: T) => {
    try {
      const a = C.agentById(roomId, agent.id);
      if (!a) return { content: [{ type: "text" as const, text: "Error: this agent was removed from the room." }], isError: true };
      C.touchAgent(a);
      const out = await fn(args || ({} as T), a);
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return { content: [{ type: "text" as const, text: text + footer() }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message || e}` }], isError: true };
    }
  };
  const tool = (name: string, description: string, schema: Record<string, z.ZodTypeAny>, fn: (args: any, a: A) => any) =>
    server.registerTool(name, { description, inputSchema: schema }, wrap(fn) as any);

  const fmtMsg = (m: any, viewer: string) =>
    `[#${m.id} ${m.created_at.slice(11, 16)} ${C.channelLabel(roomId, m.channel, viewer)}] ${m.author}: ${m.body}`;

  // ===== Context & docs =====
  tool("get_context",
    "START HERE and call again after every finished task. Returns your role, the room phase, your NEXT ACTION, ledger entries you must ack, your tasks, and (first call) all team docs and agent profiles; later calls return only what changed.",
    { full: z.boolean().optional().describe("Force the full context instead of changes only") },
    ({ full }, a) => buildContext(a, { full }));

  tool("list_docs", "List all documents in the room knowledge base (team docs, agent profiles, generated docs). PDF uploads are listed with their page count; read_doc returns their extracted text.", {},
    () => C.listDocs(roomId).map((d) => `${d.path}  v${d.version}  ${d.size} chars${d.pdf_pages != null ? `  (PDF, ${d.pdf_pages} pages)` : ""}  by ${d.updated_by}`).join("\n"));

  tool("read_doc", "Read a knowledge-base document by path, e.g. /team/requirements.md, /team/architecture.pdf, /agents/<name>/profile.md, /generated/api-contract.md. For an uploaded PDF it returns the extracted text plus a download link for the original (with images and diagrams). Long docs come in chunks: pass offset to continue.",
    { path: z.string(), offset: z.number().int().min(0).optional().describe("Character offset to continue a long document from") },
    ({ path, offset = 0 }) => {
      const d = C.getDoc(roomId, C.normDocPath(path)) || C.fail(`not found: ${path}. Use list_docs.`);
      const out = [`# ${d.path} (v${d.version}, by ${d.updated_by})`];
      const f = F.fileMeta(d.id, d.version);
      if (f) {
        const file = `/tmp/${f.name.replace(/[^\w.-]+/g, "_")}`;
        out.push(`Original PDF "${f.name}" (${f.pages} pages, ${Math.ceil(f.size / 1024)} KB), with images and diagrams. Download link, valid for 1 hour:`,
          F.signedFileLink(hubUrl, f),
          `e.g. curl -fsSL "<link>" -o ${file}  then open ${file} with your file-reading tool (Claude Code's Read tool shows PDF pages, diagrams included).`);
      }
      const end = Math.min(d.content.length, offset + READ_CHUNK);
      out.push("", d.content.slice(offset, end));
      if (end < d.content.length) out.push("", `…(showing characters ${offset}–${end} of ${d.content.length}: call read_doc with offset=${end} for the rest)`);
      return out.join("\n");
    });

  tool("write_doc",
    "Create or update a document under /generated/ (agents cannot edit /team/ or profiles). Use /generated/api-contract.md for the frontend↔backend contract and /generated/decisions.md for decision details. After an important change, also publish to the ledger.",
    { path: z.string(), content: z.string(), mode: z.enum(["replace", "append"]).optional(), base_version: z.number().int().optional().describe("Version you based your edit on; prevents overwriting someone else's change") },
    ({ path, content, mode, base_version }) => {
      const r = C.writeDoc(roomId, path, content, me, { mode, baseVersion: base_version });
      return `Saved ${r.path} (v${r.version}).`;
    });

  tool("search_docs", "Full-text search across all room documents.", { query: z.string() },
    ({ query }) => C.searchDocs(roomId, query).map((h) => `${h.path}:${h.line}  ${h.text}`).join("\n") || "No matches.");

  // ===== Plan =====
  tool("get_plan", "Show the current plan: goal, milestones, workstreams, every agent's subplan and comments.", {},
    () => {
      const p = P.planView(roomId);
      if (!p) return "No plan yet.";
      const lines = [`Plan v${p.version} (${p.status}) by ${p.created_by}`, `Goal: ${p.goal}`, p.overview, "", "Milestones:", ...p.milestones.map((m: any) => `- ${m.key}: ${m.title}`), "", "Workstreams:"];
      for (const w of p.workstreams) {
        lines.push(`## ${w.agent}: ${w.summary}`);
        const s = p.subplans.find((x: any) => x.agent.toLowerCase() === w.agent.toLowerCase());
        if (!s) { lines.push("  (subplan missing)"); continue; }
        if (s.summary) lines.push(`  ${s.summary}`);
        for (const t of s.tasks) lines.push(`  - ${t.key} [${t.milestone}] ${t.title}${t.depends_on.length ? ` ← ${t.depends_on.join(", ")}` : ""}${t.paths.length ? ` {${t.paths.join(", ")}}` : ""}${t.acceptance ? `\n      done when: ${t.acceptance}` : ""}${t.subtasks.length ? `\n      subtasks: ${t.subtasks.join("; ")}` : ""}`);
      }
      if (p.comments.length) lines.push("", "Comments:", ...p.comments.map((c: any) => `- ${c.author}: ${c.body}`));
      return lines.join("\n");
    });

  const msSchema = z.array(z.object({ key: z.string(), title: z.string() }));
  tool("propose_plan",
    "LEAD AGENT ONLY, planning phase. Draft (or redraft) the overall plan: goal, milestones and one workstream per agent. Each agent then adds a subplan for its workstream.",
    {
      goal: z.string(), overview: z.string().optional().describe("Markdown: approach, architecture boundaries, API ownership, risks"),
      milestones: msSchema.describe("Ordered, e.g. [{key:'m1', title:'Auth + skeleton'}]"),
      workstreams: z.array(z.object({ agent: z.string(), summary: z.string() })),
    },
    (args, a) => { const r = P.proposePlan(a, args); return `Plan v${r.version} drafted. Agents were notified to write subplans.`; });

  tool("comment_plan", "Comment on the current plan (concerns, missing work, dependency issues). The lead is notified.", { body: z.string() },
    ({ body }) => { P.commentPlan(roomId, me, body); return "Comment added."; });

  const taskInput = z.object({
    key: z.string().describe("Unique key prefixed with your area, e.g. fe-1"),
    title: z.string(), description: z.string().optional(), acceptance: z.string().optional().describe("Acceptance criteria — when is it done"),
    milestone: z.string().optional().describe("Milestone key"), depends_on: z.array(z.string()).optional().describe("Keys of tasks (any agent's) that must be done first"),
    paths: z.array(z.string()).optional().describe("Files/dirs this task touches, e.g. frontend/src/auth/**"),
    subtasks: z.array(z.string()).optional(),
  });
  tool("propose_subplan", "Planning phase. Submit (or replace) the detailed subplan for YOUR workstream: concrete tasks with acceptance criteria, paths, dependencies and subtasks.",
    { summary: z.string().optional(), tasks: z.array(taskInput) },
    (args, a) => { const r = P.proposeSubplan(a, args); return `Subplan saved for plan v${r.planVersion} (${r.tasks} tasks).`; });

  tool("submit_plan_for_review", "LEAD AGENT ONLY. When all subplans are in and consistent, submit the plan for human approval.", {},
    (_args, a) => { const r = P.submitForReview(a); return `Plan v${r.version} submitted. Humans will approve or request changes in the web UI.`; });

  tool("propose_plan_change", "Executing phase. Propose a change to the approved plan (e.g. new tasks). Humans approve it in the UI; affected agents see it in the ledger.",
    { title: z.string(), rationale: z.string(), new_tasks: z.array(taskInput.extend({ owner: z.string().optional(), depends_on: z.array(z.string()).optional().describe('Existing task numbers like "#4"') })).optional() },
    (args, a) => { const r = P.proposePlanChange(a, args); return `Plan change submitted as ledger #${r.ledgerId} (${r.status}).`; });

  // ===== Tasks =====
  tool("list_tasks", "List tasks (default: open ones) with owner, status, blockers and PRs.",
    { mine: z.boolean().optional(), include_done: z.boolean().optional() },
    ({ mine, include_done }, a) => {
      if (mine) return myTasksBlock(a);
      const ts = P.listTasks(roomId).filter((t: any) => include_done || t.status !== "done");
      return ts.map((t: any) => `#${t.number} [${t.status}] ${t.title} — ${t.owner ? "@" + t.owner : "unassigned"}${t.milestone ? ` (${t.milestone.key})` : ""}${t.blocked_by.length ? ` blocked by ${t.blocked_by.map((n: number) => "#" + n).join(",")}` : ""}`).join("\n") || "No tasks.";
    });

  tool("get_task", "Full details of one task: description, acceptance, deps, paths, subtasks (with ids), notes, PR.", { number: z.number().int() },
    ({ number }) => {
      const t = P.taskView(roomId, P.getTaskByNumber(roomId, number)) || C.fail(`task #${number} not found`);
      return [
        `#${t.number} [${t.status}] ${t.title} — ${t.owner ? "@" + t.owner : "unassigned"}${t.milestone ? `, milestone ${t.milestone.key}` : ""}`,
        t.description, t.acceptance ? `Done when: ${t.acceptance}` : "",
        t.depends_on.length ? `Depends on: ${t.deps.map((d: any) => `#${d.number} [${d.status}]`).join(", ")}` : "",
        t.paths.length ? `Paths: ${t.paths.join(", ")}` : "",
        t.subtasks.length ? "Subtasks:\n" + t.subtasks.map((s: any) => `  [${s.done ? "x" : " "}] (id ${s.id}) ${s.title}`).join("\n") : "",
        t.notes.length ? "Notes:\n" + t.notes.map((n: any) => `  - ${n.author}: ${n.body}`).join("\n") : "",
        t.pr ? `PR: #${t.pr.number} ${t.pr.state} ${t.pr.url}` : "",
      ].filter(Boolean).join("\n");
    });

  tool("create_task", "Executing phase. Create a small extra task (for yourself or another agent). Bigger scope changes → propose_plan_change.",
    { title: z.string(), description: z.string().optional(), acceptance: z.string().optional(), owner: z.string().optional(), depends_on: z.array(z.string()).optional(), paths: z.array(z.string()).optional(), subtasks: z.array(z.string()).optional(), milestone: z.string().optional() },
    (args) => `Created task #${P.createTask(roomId, me, args)}.`);

  tool("claim_task", "Start working on a task: assigns it to you, sets in_progress and claims its paths. Fails if dependencies are not done.",
    { number: z.number().int(), force: z.boolean().optional() },
    ({ number, force }, a) => {
      const r = P.claimTask(a, number, force);
      return `You are on #${number}. Branch: room/${number}-<slug>.${r.claims.claimed.length ? ` Claimed paths: ${r.claims.claimed.join(", ")}.` : ""}${r.claims.conflicts.length ? `\n⚠ Path conflicts: ${r.claims.conflicts.join("; ")} — coordinate before editing.` : ""}`;
    });

  tool("update_task", "Change status (todo, in_progress, blocked, review, done) and/or add a progress note. Usually: status=review after opening the PR (merge marks it done automatically).",
    { number: z.number().int(), status: z.enum(P.TASK_STATUSES).optional(), note: z.string().optional(), owner: z.string().optional() },
    ({ number, ...rest }) => { const t = P.updateTask(roomId, me, number, rest); return `#${t.number} is now ${t.status}.`; });

  tool("add_subtasks", "Add checklist items to a task.", { number: z.number().int(), subtasks: z.array(z.string()) },
    ({ number, subtasks }) => { const t = P.addSubtasks(roomId, me, number, subtasks); return t.subtasks.map((s: any) => `(id ${s.id}) ${s.title}`).join("\n"); });

  tool("check_subtask", "Mark a subtask done (or not). Get ids from get_task.", { subtask_id: z.number().int(), done: z.boolean().optional() },
    ({ subtask_id, done = true }) => { const r = P.checkSubtask(roomId, me, subtask_id, done); return `#${r.task}: "${r.subtask}" ${r.done ? "done" : "reopened"}.`; });

  tool("claim_paths", "Soft-lock files/directories you are about to edit (glob-like, e.g. backend/src/auth/**). Warns about overlaps with other agents.",
    { paths: z.array(z.string()), task_number: z.number().int().optional() },
    ({ paths, task_number }, a) => {
      const t = task_number ? P.getTaskByNumber(roomId, task_number) : null;
      const r = C.claimPaths(a, paths, t?.id || null);
      return `Claimed: ${r.claimed.join(", ") || "nothing"}${r.conflicts.length ? `\n⚠ Not claimed (overlap): ${r.conflicts.join("; ")}` : ""}`;
    });

  tool("release_paths", "Release your path claims (all, or given patterns).", { paths: z.array(z.string()).optional() },
    ({ paths }, a) => `Released ${C.releasePaths(a, paths)} claim(s).`);

  // ===== Ledger =====
  tool("publish",
    "Publish an IMPORTANT fact every relevant agent must know (decision, api_change, env_change, blocker, handoff, milestone). NOT for small local changes. Set affects to agent names when it concerns specific agents.",
    { kind: z.enum(["decision", "api_change", "env_change", "blocker", "handoff", "milestone"]), title: z.string(), body: z.string().optional(), affects: z.array(z.string()).optional().describe("Agent names; default all") },
    (args) => `Published ledger #${C.publish(roomId, me, args)}.`);

  tool("ack", "Acknowledge ledger entries after you read them and adapted your work.", { ids: z.array(z.number().int()) },
    ({ ids }, a) => { const ok = C.ack(a, ids); return ok.length ? `Acknowledged ${ok.map((i) => "#" + i).join(", ")}.` : "Nothing acknowledged (unknown ids)."; });

  // ===== Chat =====
  tool("send_message",
    "Send a message. to = agent name or teammate username for a direct message; channel = 'general' or 'task:<n>'. Mention @name in general to notify someone.",
    { text: z.string(), to: z.string().optional(), channel: z.string().optional() },
    ({ text, to, channel }, a) => {
      let ch = channel || "general";
      if (to) { const p = C.resolveParticipant(roomId, to); ch = C.dmChannel(`agent:${a.id}`, p.ref); }
      const r = C.postMessage(roomId, me, ch, text);
      return `Sent (#${r.id}) to ${C.channelLabel(roomId, ch, `agent:${a.id}`)}.`;
    });

  tool("read_messages", "Read your unread messages (general, your DMs, your task channels) and mark them read. history_channel re-reads a channel.",
    { history_channel: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    ({ history_channel, limit = 50 }, a) => {
      const viewer = `agent:${a.id}`;
      if (history_channel) return C.channelHistory(roomId, history_channel, limit).map((m) => fmtMsg(m, viewer)).join("\n") || "(empty)";
      const msgs = C.unreadForAgent(a, limit);
      if (!msgs.length) return "No unread messages.";
      C.markRead(a, msgs[msgs.length - 1].id);
      return msgs.map((m) => fmtMsg(m, viewer)).join("\n");
    });

  tool("wait_for_messages", "Wait until a message for you arrives (or timeout), then return it. Use when you need another agent's answer to continue.",
    { timeout_seconds: z.number().int().min(5).max(110).optional() },
    async ({ timeout_seconds = 45 }, a) => {
      const got = await C.waitForMessage(a, timeout_seconds * 1000);
      if (!got) return `Nothing new in ${timeout_seconds}s. Continue other work or wait again.`;
      const fresh = C.agentById(roomId, a.id)!;
      const msgs = C.unreadForAgent(fresh, 50);
      if (msgs.length) C.markRead(fresh, msgs[msgs.length - 1].id);
      return msgs.map((m) => fmtMsg(m, `agent:${a.id}`)).join("\n") || "You were notified of a change — call get_context.";
    });

  tool("set_status", "Tell the room what you are doing right now (one line).", { status: z.string() },
    ({ status }, a) => { C.setStatus(a, status); return "Status updated."; });

  // ===== Git =====
  tool("link_pr", "Link a GitHub PR to a task (if the branch/body convention was not used) and move it to review.", { number: z.number().int(), url: z.string() },
    ({ number, url }) => { const r = G.linkPr(roomId, me, number, url); return `Linked PR #${r.pr} to task #${r.task}.`; });

  tool("get_pr_feedback", "Get PR state, CI result, review comments and other feedback for a task's PR.", { number: z.number().int() },
    ({ number }) => G.prFeedbackForTask(roomId, number));

  // ===== Subagents =====
  tool("get_subagent_templates",
    "Get the team's subagent templates. For Claude Code, write each returned file to the given path (.claude/agents/<name>.md) so you can delegate to them.",
    {},
    (_a, a) => {
      const docs = C.listDocs(roomId).filter((d) => d.path.startsWith("/team/subagents/"));
      if (!docs.length) return "No subagent templates in /team/subagents/.";
      return docs.map((d) => {
        const name = d.path.split("/").pop()!.replace(/\.md$/, "");
        const target = a.agent_type === "claude" ? `.claude/agents/${name}.md` : `(reference only for ${a.agent_type}; use your tool's own subagent format)`;
        return `=== ${target} ===\n${C.getDoc(roomId, d.path)!.content}`;
      }).join("\n\n");
    });

  // ===== Prompts (appear as slash commands in clients that support MCP prompts) =====
  const prompt = (name: string, description: string, text: (a?: any) => string, args?: Record<string, z.ZodTypeAny>) =>
    server.registerPrompt(name, { description, argsSchema: args as any }, ((a: any) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: typeof text === "function" ? (text as any)(a) : text } }],
    })) as any);

  prompt("start", "Join the team room: load context and begin your next action.", () =>
    "Call get_context from the room MCP server. Read everything carefully, ack any ledger entries after reading them, read_messages, and then perform the Next action it gives you. Follow /team/workflow.md strictly.");
  prompt("plan", "Planning: draft the plan (lead) or write your subplan.", () =>
    "We are in planning. Call get_context, then get_plan. If you are the lead and there is no plan, draft it with propose_plan right away. Otherwise write a detailed subplan for your workstream with propose_subplan (tasks with keys, acceptance criteria, paths, depends_on, subtasks). Do not stop to wait for answers: write open questions down as assumptions (plan overview / subplan summary) and ask in general in parallel. Coordinate API boundaries with other agents via send_message. Lead: submit_plan_for_review when all subplans are consistent.");
  prompt("sync", "Catch up with the room: changes, ledger, messages.", () =>
    "Call get_context (changes since last time), ack ledger entries after adapting, read_messages and reply where needed. Then continue your current task.");
  prompt("finish_task", "Finish the current task: tests, PR, status, notes.", (a: any) =>
    `Finish task #${a?.number || "<current>"}: run the tests for your area, make sure every acceptance criterion is met and subtasks are checked, commit with "#<n> ..." messages, push branch room/<n>-<slug>, open a PR with "Task: #<n>" in the body, call link_pr if needed, update_task status=review with a short note (what changed, which files), publish to the ledger only if you changed something others depend on (API, env, shared types). Then get_context for your next action.`,
    { number: z.string().optional() });

  // ===== Resources: every doc as room://docs/<path> =====
  server.registerResource("room-docs", new ResourceTemplate("room://docs{+path}", {
    list: async () => ({ resources: C.listDocs(roomId).map((d) => ({ uri: `room://docs${d.path}`, name: d.path, mimeType: "text/markdown" })) }),
  }), { description: "Room knowledge base documents", mimeType: "text/markdown" }, async (uri: URL, vars: any) => {
    const path = String(vars.path || "");
    const d = C.getDoc(roomId, C.normDocPath(path));
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: d ? d.content : `Not found: ${path}` }] };
  });

  return server;
}
