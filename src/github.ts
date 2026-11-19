// GitHub integration via repository webhooks (+ optional token for reading PR files).
// PR ↔ task linking, automatic task statuses, review/CI feedback to the owning agent, conflict detection.
import crypto from "node:crypto";
import { db, now, json } from "./db.js";
import { randomToken, newId } from "./auth.js";
import { Actor, fail, activity, postMessage, wake, agentById, roomChanged } from "./core.js";
import { getTaskByNumber, onTaskDone } from "./planning.js";

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const GH: Actor = { kind: "github", name: "github" };
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function addRepo(roomId: string, by: Actor, fullName: string, apiToken?: string, defaultBranch?: string) {
  fullName = String(fullName || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!REPO_RE.test(fullName)) fail("repository must look like owner/name");
  if (db.prepare("SELECT 1 FROM repos WHERE room_id = ? AND full_name = ?").get(roomId, fullName)) fail("repository already connected");
  const id = newId();
  const secret = randomToken(24);
  db.prepare("INSERT INTO repos (id, room_id, full_name, webhook_secret, api_token, default_branch, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, roomId, fullName, secret, apiToken || null, defaultBranch || "main", now());
  activity(roomId, by, "repo", `${by.name} connected repository ${fullName}`);
  return { id, fullName, secret };
}

export const reposOf = (roomId: string, withSecrets = false) =>
  (db.prepare("SELECT * FROM repos WHERE room_id = ? ORDER BY created_at").all(roomId) as any[]).map((r) => ({
    id: r.id, full_name: r.full_name, default_branch: r.default_branch, created_at: r.created_at,
    has_token: !!r.api_token, ...(withSecrets ? { webhook_secret: r.webhook_secret } : {}),
  }));

export function updateRepo(roomId: string, repoId: string, input: any) {
  const r = db.prepare("SELECT id FROM repos WHERE id = ? AND room_id = ?").get(repoId, roomId);
  if (!r) fail("repo not found", 404);
  if (input.apiToken !== undefined) db.prepare("UPDATE repos SET api_token = ? WHERE id = ?").run(input.apiToken || null, repoId);
  if (input.defaultBranch) db.prepare("UPDATE repos SET default_branch = ? WHERE id = ?").run(input.defaultBranch, repoId);
  roomChanged(roomId, "repos");
}

export function deleteRepo(roomId: string, repoId: string, by: Actor) {
  const r = db.prepare("SELECT full_name FROM repos WHERE id = ? AND room_id = ?").get(repoId, roomId) as any;
  if (!r) fail("repo not found", 404);
  db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);
  activity(roomId, by, "repo", `${by.name} disconnected ${r.full_name}`);
}

export function verifySignature(secret: string, raw: Buffer, header?: string) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(header);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

export function linkTaskNumber(branch: string, body: string | null) {
  const b = /(?:^|\/)room\/(\d+)(?:-|$)/.exec(branch || "") || /^(\d+)-/.exec(branch || "");
  if (b) return Number(b[1]);
  const m = /Task:\s*#(\d+)/i.exec(body || "");
  return m ? Number(m[1]) : null;
}

function ownerOf(roomId: string, taskId: number | null) {
  if (!taskId) return null;
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  return t ? { task: t, agent: t.owner_agent_id ? agentById(roomId, t.owner_agent_id) : null } : null;
}

function notifyTask(roomId: string, taskId: number | null, text: string) {
  const o = ownerOf(roomId, taskId);
  if (!o) return;
  postMessage(roomId, GH, `task:${o.task.number}`, text); // wakes the owner
}

function upsertPr(repo: any, pr: any) {
  const taskNumber = linkTaskNumber(pr.head?.ref, pr.body);
  const task = taskNumber ? getTaskByNumber(repo.room_id, taskNumber) : null;
  const state = pr.merged || pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
  db.prepare(
    `INSERT INTO prs (room_id, repo_id, number, title, url, branch, head_sha, state, task_id, author, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repo_id, number) DO UPDATE SET title=excluded.title, url=excluded.url, branch=excluded.branch,
       head_sha=excluded.head_sha, state=excluded.state, task_id=COALESCE(excluded.task_id, prs.task_id), updated_at=excluded.updated_at`
  ).run(repo.room_id, repo.id, pr.number, pr.title || "", pr.html_url || "", pr.head?.ref || "", pr.head?.sha || null, state,
    task?.id || null, pr.user?.login || null, now());
  if (task) db.prepare("UPDATE tasks SET pr_number = ?, pr_url = ?, branch = ?, updated_at = ? WHERE id = ?").run(pr.number, pr.html_url, pr.head?.ref, now(), task.id);
  return db.prepare("SELECT * FROM prs WHERE repo_id = ? AND number = ?").get(repo.id, pr.number) as any;
}

async function fetchFiles(repo: any, number: number): Promise<string[] | null> {
  if (!repo.api_token) return null;
  try {
    const res = await fetch(`${API}/repos/${repo.full_name}/pulls/${number}/files?per_page=100`, {
      headers: { Authorization: `Bearer ${repo.api_token}`, Accept: "application/vnd.github+json", "User-Agent": "agent-rooms" },
    });
    if (!res.ok) return null;
    return ((await res.json()) as any[]).map((f) => f.filename);
  } catch { return null; }
}

async function detectConflicts(repo: any, prRow: any) {
  const files = await fetchFiles(repo, prRow.number);
  if (!files) return;
  db.prepare("UPDATE prs SET files = ? WHERE id = ?").run(JSON.stringify(files), prRow.id);
  const others = db.prepare("SELECT * FROM prs WHERE room_id = ? AND id != ? AND state IN ('open','draft')").all(repo.room_id, prRow.id) as any[];
  const reported = new Set(json<string[]>(prRow.conflicts, []));
  for (const o of others) {
    const overlap = json<string[]>(o.files, []).filter((f) => files.includes(f));
    const key = `${o.repo_id}#${o.number}:${overlap.sort().join("|")}`;
    if (!overlap.length || reported.has(key)) continue;
    reported.add(key);
    const text = `⚠ Possible merge conflict: PR #${prRow.number} and PR #${o.number} both change ${overlap.slice(0, 10).join(", ")}${overlap.length > 10 ? "…" : ""}. Coordinate who merges first and rebase.`;
    activity(repo.room_id, GH, "pr", text);
    notifyTask(repo.room_id, prRow.task_id, text);
    notifyTask(repo.room_id, o.task_id, text);
  }
  db.prepare("UPDATE prs SET conflicts = ? WHERE id = ?").run(JSON.stringify([...reported]), prRow.id);
}

function addFeedback(prRow: any, kind: string, author: string, body: string, path?: string) {
  db.prepare("INSERT INTO pr_feedback (pr_id, kind, author, body, path, created_at) VALUES (?,?,?,?,?,?)").run(prRow.id, kind, author, body.slice(0, 10000), path || null, now());
}

export async function handleWebhook(repoId: string, event: string, raw: Buffer, signature?: string) {
  const repo = db.prepare("SELECT * FROM repos WHERE id = ?").get(repoId) as any;
  if (!repo) fail("unknown repository", 404);
  if (!verifySignature(repo.webhook_secret, raw, signature)) fail("invalid signature", 401);
  const p = JSON.parse(raw.toString("utf8"));
  const roomId = repo.room_id;

  if (event === "ping") return { ok: true, pong: true };

  if (event === "pull_request") {
    const pr = p.pull_request;
    const row = upsertPr(repo, pr);
    const o = ownerOf(roomId, row.task_id);
    const label = `PR #${pr.number} "${pr.title}"`;
    if (["opened", "reopened", "ready_for_review"].includes(p.action)) {
      activity(roomId, GH, "pr", `${label} opened${o ? ` for task #${o.task.number}` : " (not linked to a task — use branch room/<n>-slug or 'Task: #n')"}`);
      if (o && o.task.status !== "done" && o.task.status !== "review")
        db.prepare("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?").run(now(), o.task.id);
      await detectConflicts(repo, row);
    } else if (p.action === "synchronize") {
      roomChanged(roomId, "prs");
      await detectConflicts(repo, row);
    } else if (p.action === "closed") {
      if (pr.merged) {
        activity(roomId, GH, "pr", `${label} merged${o ? ` → task #${o.task.number} done` : ""}`);
        if (o && o.task.status !== "done") {
          db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(now(), o.task.id);
          onTaskDone(roomId, getTaskByNumber(roomId, o.task.number), GH);
          if (o.agent) wake(roomId, [o.agent.id], `PR #${pr.number} merged, task #${o.task.number} done`);
        }
      } else {
        activity(roomId, GH, "pr", `${label} closed without merge`);
        if (o && o.task.status === "review") db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now(), o.task.id);
        notifyTask(roomId, row.task_id, `${label} was closed without merging.`);
      }
    }
    roomChanged(roomId, "tasks");
    return { ok: true };
  }

  if (event === "pull_request_review") {
    const row = upsertPr(repo, p.pull_request);
    const r = p.review;
    if (p.action !== "submitted" || (!r.body && r.state === "commented")) return { ok: true };
    addFeedback(row, `review:${r.state}`, r.user?.login || "reviewer", r.body || r.state);
    activity(roomId, GH, "pr", `Review on PR #${row.number}: ${r.state} by ${r.user?.login}`);
    if (r.state === "changes_requested" || r.body)
      notifyTask(roomId, row.task_id, `Review on PR #${row.number} (${r.state}) by ${r.user?.login}:\n${r.body || ""}\nCall get_pr_feedback for details and fix.`);
    return { ok: true };
  }

  if (event === "pull_request_review_comment" && p.action === "created") {
    const row = upsertPr(repo, p.pull_request);
    const c = p.comment;
    addFeedback(row, "review_comment", c.user?.login || "reviewer", c.body, `${c.path}:${c.line || c.original_line || ""}`);
    notifyTask(roomId, row.task_id, `Review comment on PR #${row.number} ${c.path}:${c.line || ""} by ${c.user?.login}: ${c.body}`);
    return { ok: true };
  }

  if (event === "issue_comment" && p.action === "created" && p.issue?.pull_request) {
    const row = db.prepare("SELECT * FROM prs WHERE repo_id = ? AND number = ?").get(repo.id, p.issue.number) as any;
    if (!row) return { ok: true, ignored: "unknown PR" };
    addFeedback(row, "comment", p.comment.user?.login || "user", p.comment.body);
    notifyTask(roomId, row.task_id, `Comment on PR #${row.number} by ${p.comment.user?.login}: ${p.comment.body}`);
    return { ok: true };
  }

  // CI: check_suite / check_run / status
  let ciPrs: any[] = [];
  let conclusion: string | null = null;
  let ciName = "";
  if (event === "check_suite" && p.action === "completed") {
    conclusion = p.check_suite.conclusion; ciName = p.check_suite.app?.name || "checks";
    ciPrs = (p.check_suite.pull_requests || []).map((x: any) => x.number);
  } else if (event === "check_run" && p.action === "completed") {
    conclusion = p.check_run.conclusion; ciName = p.check_run.name;
    ciPrs = (p.check_run.pull_requests || []).map((x: any) => x.number);
    if (!ciPrs.length && p.check_run.head_sha) ciPrs = (db.prepare("SELECT number FROM prs WHERE repo_id = ? AND head_sha = ?").all(repo.id, p.check_run.head_sha) as any[]).map((x) => x.number);
  } else if (event === "status" && ["success", "failure", "error"].includes(p.state)) {
    conclusion = p.state === "error" ? "failure" : p.state; ciName = p.context || "status";
    ciPrs = (db.prepare("SELECT number FROM prs WHERE repo_id = ? AND head_sha = ?").all(repo.id, p.sha) as any[]).map((x) => x.number);
  }
  if (conclusion) {
    for (const n of ciPrs) {
      const row = db.prepare("SELECT * FROM prs WHERE repo_id = ? AND number = ?").get(repo.id, n) as any;
      if (!row) continue;
      const state = conclusion === "success" ? "passing" : ["failure", "timed_out", "cancelled", "action_required"].includes(conclusion) ? "failing" : conclusion;
      db.prepare("UPDATE prs SET ci_state = ?, updated_at = ? WHERE id = ?").run(state, now(), row.id);
      if (state === "failing") {
        const details = p.check_run?.output?.summary || p.check_run?.output?.title || p.description || p.target_url || "";
        addFeedback(row, "ci", ciName, `CI ${conclusion}: ${ciName}. ${details}`.trim());
        activity(roomId, GH, "ci", `CI failed on PR #${n} (${ciName})`);
        notifyTask(roomId, row.task_id, `CI failed on PR #${n} (${ciName}). ${details}\nRun the tests locally, fix, push. get_pr_feedback has details.`);
      } else roomChanged(roomId, "prs");
    }
    return { ok: true };
  }
  return { ok: true, ignored: event };
}

export function prsOf(roomId: string) {
  const prs = db.prepare(
    `SELECT p.*, r.full_name AS repo, t.number AS task_number, t.title AS task_title FROM prs p JOIN repos r ON r.id = p.repo_id
     LEFT JOIN tasks t ON t.id = p.task_id WHERE p.room_id = ? ORDER BY p.updated_at DESC LIMIT 200`
  ).all(roomId) as any[];
  return prs.map((p) => ({
    ...p, files: json<string[]>(p.files, []), conflicts: undefined,
    feedback: db.prepare("SELECT kind, author, body, path, created_at FROM pr_feedback WHERE pr_id = ? ORDER BY id DESC LIMIT 30").all(p.id),
  }));
}

export function prFeedbackForTask(roomId: string, taskNumber: number) {
  const t = getTaskByNumber(roomId, taskNumber) || fail(`task #${taskNumber} not found`, 404);
  const prs = db.prepare("SELECT p.*, r.full_name AS repo FROM prs p JOIN repos r ON r.id = p.repo_id WHERE p.task_id = ? ORDER BY p.updated_at DESC").all(t.id) as any[];
  if (!prs.length) return `No PR linked to task #${taskNumber}. Open one with branch room/${taskNumber}-<slug> or body "Task: #${taskNumber}", or call link_pr.`;
  return prs.map((p) => {
    const fb = db.prepare("SELECT kind, author, body, path, created_at FROM pr_feedback WHERE pr_id = ? ORDER BY id").all(p.id) as any[];
    return [`PR #${p.number} (${p.repo}) "${p.title}" — ${p.state}${p.ci_state ? `, CI ${p.ci_state}` : ""}\n${p.url}`,
      fb.length ? fb.map((f) => `- [${f.kind}] ${f.author}${f.path ? ` ${f.path}` : ""}: ${f.body}`).join("\n") : "No feedback yet."].join("\n");
  }).join("\n\n");
}

// Manual linking (when the agent opened a PR without the naming convention or webhooks are not set up).
export function linkPr(roomId: string, by: Actor, taskNumber: number, url: string) {
  const t = getTaskByNumber(roomId, taskNumber) || fail(`task #${taskNumber} not found`, 404);
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url || "");
  if (!m) fail("url must be a GitHub pull request URL");
  const number = Number(m[2]);
  db.prepare("UPDATE tasks SET pr_url = ?, pr_number = ?, status = CASE WHEN status IN ('todo','in_progress','blocked') THEN 'review' ELSE status END, updated_at = ? WHERE id = ?")
    .run(url, number, now(), t.id);
  const repo = db.prepare("SELECT * FROM repos WHERE room_id = ? AND full_name = ? COLLATE NOCASE").get(roomId, m[1]) as any;
  if (repo) {
    db.prepare(
      `INSERT INTO prs (room_id, repo_id, number, title, url, branch, state, task_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repo_id, number) DO UPDATE SET task_id = excluded.task_id, url = excluded.url`
    ).run(roomId, repo.id, number, t.title, url, t.branch || "", "open", t.id, now());
  }
  activity(roomId, by, "pr", `${by.name} linked PR #${number} to task #${taskNumber}`, { task: taskNumber });
  return { task: taskNumber, pr: number };
}
