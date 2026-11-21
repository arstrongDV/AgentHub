// End-to-end test of the whole workflow. Starts its own server (temp DB) + a fake GitHub API.
//   npm test
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 4590, GH_PORT = 4591;
const H = `http://localhost:${PORT}`;
let passed = 0;
const ok = (cond: any, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++; console.log(`  ✓ ${msg}`);
};

// ---- fake GitHub API (PR files for conflict detection, PR list + CI for polling sync) ----
const prFiles: Record<string, string[]> = {};
const pulls: Record<string, any> = {};
const checkRuns: Record<string, any[]> = {};
const gh = http.createServer((req, res) => {
  const url = req.url || "";
  const send = (body: any, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (url.startsWith("/repos/acme/private/")) return send({ message: "Not Found" }, 404);
  let m = /\/repos\/.+\/pulls\/(\d+)\/files/.exec(url);
  if (m) return send((prFiles[m[1]] || []).map((filename) => ({ filename })));
  if (/\/repos\/[^/]+\/[^/]+\/pulls\?/.test(url)) return send(Object.values(pulls));
  if ((m = /\/repos\/.+\/pulls\/(\d+)$/.exec(url))) return pulls[m[1]] ? send(pulls[m[1]]) : send({ message: "Not Found" }, 404);
  if ((m = /\/commits\/([^/]+)\/check-runs/.exec(url))) return send({ total_count: (checkRuns[m[1]] || []).length, check_runs: checkRuns[m[1]] || [] });
  if (/\/commits\/[^/]+\/status$/.test(url)) return send({ state: "pending", total_count: 0, statuses: [] });
  send([]);
}).listen(GH_PORT);

const dbFile = path.join(os.tmpdir(), `ar-e2e-${Date.now()}.db`);
const srv = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "src/server.ts"], {
  env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile, GITHUB_API_URL: `http://localhost:${GH_PORT}` }, stdio: ["ignore", "pipe", "inherit"],
});
const cleanup = () => { srv.kill(); gh.close(); for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true }); };

// ---- tiny HTTP client with cookies ----
function client() {
  let cookie = "";
  // A Buffer body is sent raw as a PDF (uploads); anything else as JSON.
  return async (method: string, p: string, body?: any) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(H + p, {
      method, headers: { "content-type": raw ? "application/pdf" : "application/json", "x-requested-with": "agent-rooms", cookie },
      body: raw ? new Uint8Array(body) : body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString();
    let data: any = text; try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, buf, headers: res.headers };
  };
}
async function mcp(token: string) {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${H}/mcp/${token}`)));
  const call = async (name: string, args: any = {}) => {
    const r: any = await c.callTool({ name, arguments: args });
    return { text: r.content[0].text as string, error: !!r.isError };
  };
  return { c, call };
}
function agentEvents(token: string) {
  const events: any[] = [];
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${H}/api/agent/${token}/events`, { signal: ctrl.signal });
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of res.body as any) {
        buf += dec.decode(chunk, { stream: true });
        let i; while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:")); buf = buf.slice(i + 2);
          if (line) events.push(JSON.parse(line.slice(5)));
        }
      }
    } catch {}
  })();
  return { events, stop: () => ctrl.abort() };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Minimal one-page PDF with real text (Helvetica), xref offsets computed so pdf.js parses it cleanly.
function makePdf(lines: string[]) {
  const stream = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) '`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
function sign(secret: string, body: string) { return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex"); }

async function main() {
  for (let i = 0; i < 50; i++) { try { await fetch(H + "/auth/config"); break; } catch { await sleep(200); } }
  const alice = client(), bob = client(), eve = client();

  console.log("Phase 0: accounts, rooms, isolation");
  ok((await alice("POST", "/auth/register", { username: "alice", password: "password123", displayName: "Alice" })).status === 200, "alice registers");
  ok((await bob("POST", "/auth/register", { username: "bob", password: "password123", displayName: "Bob" })).status === 200, "bob registers");
  ok((await eve("POST", "/auth/register", { username: "eve", password: "password123" })).status === 200, "eve registers");
  ok((await eve("POST", "/auth/login", { username: "alice", password: "wrong-pass" })).status === 401, "wrong password rejected");
  const noCsrf = await fetch(H + "/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(noCsrf.status === 403, "mutation without CSRF header rejected");
  const room = (await alice("POST", "/api/rooms", { name: "FoodShare" })).data;
  const R = `/api/rooms/${room.id}`;
  ok(room.id && room.phase === "setup", "alice creates room");
  ok((await eve("GET", R)).status === 404, "eve (not a member) gets 404 for the room");
  ok((await eve("GET", `${R}/docs`)).status === 404, "eve cannot list docs");
  ok((await eve("GET", "/api/rooms")).data.length === 0, "eve sees no rooms");
  ok((await bob("POST", `${R}/invites`, {})).status === 404, "bob cannot create invites before joining");
  const inv = (await alice("POST", `${R}/invites`, { hours: 2 })).data;
  ok((await bob("POST", "/api/invites/accept", { code: inv.code })).data.roomId === room.id, "bob joins with invite");
  ok((await eve("POST", "/api/invites/accept", { code: inv.code })).status === 404, "invite is single-use");
  ok((await bob("POST", `${R}/invites`, {})).status === 403, "member (non-owner) cannot invite");

  const fe = (await alice("POST", `${R}/agents`, { name: "claude-fe", agentType: "claude", roleTitle: "Frontend", paths: ["frontend/**"] })).data;
  const be = (await bob("POST", `${R}/agents`, { name: "cursor-be", agentType: "cursor", roleTitle: "Backend", paths: ["backend/**"] })).data;
  ok(fe.token?.startsWith("ar_") && be.token, "agents created, tokens returned once");
  const view = (await bob("GET", R)).data;
  ok(!JSON.stringify(view).includes(fe.token) && !JSON.stringify(view).includes("token_hash"), "room view never exposes tokens");
  ok((await bob("POST", `${R}/agents/${fe.agent.id}/token`)).status === 403, "bob cannot reissue alice's agent token");

  console.log("Phase 1: knowledge base");
  ok((await bob("PUT", `${R}/doc`, { path: "/agents/claude-fe/profile.md", content: "hack" })).status === 403, "bob cannot edit alice's agent profile");
  ok((await alice("PUT", `${R}/doc`, { path: "/agents/claude-fe/profile.md", content: "# claude-fe\nReact + Tailwind. Owns /frontend." })).status === 200, "alice edits her agent's profile");
  const req1 = (await bob("PUT", `${R}/doc`, { path: "/team/requirements.md", content: "# Food sharing app\nUsers post leftover food, others reserve it." })).data;
  ok(req1.version === 2, "requirements updated (v2)");
  ok((await alice("PUT", `${R}/doc`, { path: "/team/requirements.md", content: "x", baseVersion: 1 })).status === 409, "stale edit → 409 conflict");
  ok((await alice("GET", `${R}/doc/versions?path=/team/requirements.md`)).data.length === 2, "doc version history");

  const A = await mcp(fe.token), B = await mcp(be.token);
  const tools = (await A.c.listTools()).tools.map((t) => t.name);
  ok(tools.length >= 25 && tools.includes("get_context") && tools.includes("propose_subplan"), `MCP exposes ${tools.length} tools`);
  ok((await A.c.listPrompts()).prompts.map((p) => p.name).includes("start"), "MCP prompts (slash commands) available");
  const res = await A.c.listResources();
  ok(res.resources.some((r) => r.uri === "room://docs/team/workflow.md"), "docs exposed as MCP resources");
  const read = await A.c.readResource({ uri: "room://docs/team/requirements.md" });
  ok(String((read.contents[0] as any).text).includes("leftover food"), "MCP resource read works");
  let ctx = await A.call("get_context");
  ok(ctx.text.includes("/team/workflow.md") && ctx.text.includes("React + Tailwind") && ctx.text.includes("SETUP"), "get_context (full): docs, profile, phase");
  ctx = await A.call("get_context");
  ok(ctx.text.includes("What changed") && !ctx.text.includes("### /team/workflow.md"), "second get_context returns delta only");
  ok((await A.call("write_doc", { path: "/team/requirements.md", content: "x" })).error, "agent cannot write /team docs");
  ok(!(await A.call("write_doc", { path: "/generated/notes.md", content: "ok" })).error, "agent can write /generated docs");

  console.log("Phase 1b: PDF docs");
  const pdf = makePdf(["Architecture: React SPA talks to an Express REST API.", "Database: Postgres with a reservations table."]);
  const up = await alice("PUT", `${R}/doc/file?path=/team/architecture.pdf&name=${encodeURIComponent("Архітектура v1.pdf")}`, pdf);
  ok(up.status === 200 && up.data.path === "/team/architecture.pdf" && up.data.pages === 1 && up.data.chars > 0, "PDF upload: text extracted");
  ok((await bob("PUT", `${R}/doc/file?path=/team/fake.pdf`, Buffer.from("hello, this is not a pdf"))).status === 400, "non-PDF upload rejected");
  ok((await bob("PUT", `${R}/doc`, { path: "/team/new.pdf", content: "x" })).status === 400, "a .pdf doc can only be created by uploading a PDF");
  ok((await eve("GET", `${R}/doc/file?path=/team/architecture.pdf`)).status === 404, "eve (not a member) cannot download the PDF");
  const pdoc = (await bob("GET", `${R}/doc?path=/team/architecture.pdf`)).data;
  ok(pdoc.content.includes("## Page 1") && pdoc.content.includes("Express REST API") && pdoc.file?.name === "Архітектура v1.pdf" && pdoc.file.pages === 1,
    "PDF doc: extracted text + original file info");
  const served = await bob("GET", `${R}/doc/file?path=/team/architecture.pdf`);
  ok(served.status === 200 && served.headers.get("content-type") === "application/pdf" && served.buf.equals(pdf) && served.headers.get("x-frame-options") === "SAMEORIGIN",
    "original PDF served to members (embeddable only by the app)");
  ok((await bob("PUT", `${R}/doc`, { path: "/team/architecture.pdf", content: `${pdoc.content}\nAuth: JWT in an httpOnly cookie.`, baseVersion: 1 })).data.version === 2,
    "extracted text can be corrected by hand (v2)");
  ok((await bob("GET", `${R}/doc?path=/team/architecture.pdf`)).data.file?.version === 1, "a text edit keeps the original PDF");
  ok((await A.call("list_docs")).text.includes("/team/architecture.pdf") && (await A.call("list_docs")).text.includes("(PDF, 1 pages)"), "list_docs marks PDFs");
  const rd = await A.call("read_doc", { path: "/team/architecture.pdf" });
  const link = /(http\S+\/api\/files\/\S+)/.exec(rd.text)?.[1];
  ok(rd.text.includes("Express REST API") && rd.text.includes("httpOnly cookie") && !!link, "agent reads the PDF's text and gets a download link");
  const dl = await fetch(link!);
  ok(dl.status === 200 && Buffer.from(await dl.arrayBuffer()).equals(pdf), "signed link downloads the original PDF without a session");
  ok((await fetch(link!.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).status === 404, "tampered link rejected");
  ctx = await A.call("get_context");
  ok(ctx.text.includes("/team/architecture.pdf") && ctx.text.includes("Express REST API"), "get_context delta includes the uploaded PDF");
  const up2 = await alice("PUT", `${R}/doc/file?path=/team/architecture.pdf&name=arch-v2.pdf`, makePdf(["Version two: GraphQL instead of REST."]));
  const pdoc3 = (await alice("GET", `${R}/doc?path=/team/architecture.pdf`)).data;
  ok(up2.data.version === 3 && pdoc3.file.version === 3 && pdoc3.file.name === "arch-v2.pdf" && pdoc3.content.includes("GraphQL"), "re-upload = new version with the new file");
  ok((await alice("GET", `${R}/doc/file?path=/team/architecture.pdf&v=2`)).buf.equals(pdf), "older versions keep their PDF");
  await A.call("write_doc", { path: "/generated/big.md", content: "x".repeat(100000) });
  const big1 = await A.call("read_doc", { path: "/generated/big.md" }), big3 = await A.call("read_doc", { path: "/generated/big.md", offset: 80000 });
  ok(big1.text.includes("offset=40000") && big1.text.length < 41000 && !big3.text.includes("call read_doc with offset"), "read_doc returns long docs in chunks");
  ok((await alice("DELETE", `${R}/doc?path=/team/architecture.pdf`)).status === 200 && (await fetch(link!)).status === 404, "deleting the doc removes its PDFs");

  console.log("Phase 2: planning");
  ok((await alice("POST", `${R}/phase/start-planning`)).status === 400, "cannot start planning without lead");
  await alice("PUT", `${R}/lead`, { agentId: fe.agent.id });
  const evB = agentEvents(be.token);
  await sleep(200);
  ok((await alice("POST", `${R}/phase/start-planning`)).status === 200, "planning started");
  await sleep(200);
  ok(evB.events.some((e) => e.type === "wake" && /planning/.test(e.reason)), "backend agent woken: planning started");
  ok((await B.call("propose_plan", { goal: "x", milestones: [{ key: "m1", title: "a" }], workstreams: [{ agent: "cursor-be", summary: "b" }] })).error, "non-lead cannot propose the plan");
  const pp = await A.call("propose_plan", {
    goal: "MVP food sharing", overview: "REST API + React SPA",
    milestones: [{ key: "m1", title: "Auth" }, { key: "m2", title: "Listings" }],
    workstreams: [{ agent: "claude-fe", summary: "UI" }, { agent: "cursor-be", summary: "API + DB" }],
  });
  ok(!pp.error, "lead proposes plan v1");
  ctx = await B.call("get_context");
  ok(ctx.text.includes("propose_subplan"), "backend's next action: write subplan");
  ok((await A.call("submit_plan_for_review")).text.includes("cursor-be has no subplan"), "submit blocked while subplans missing");
  ok(!(await A.call("propose_subplan", { tasks: [
    { key: "fe-1", title: "Login page", milestone: "m1", depends_on: ["be-1"], paths: ["frontend/src/auth/**"], subtasks: ["form", "validation"], acceptance: "user can log in" },
    { key: "fe-2", title: "Listings page", milestone: "m2", depends_on: ["fe-1", "be-2"] },
  ] })).error, "frontend subplan");
  ok((await B.call("propose_subplan", { tasks: [{ key: "fe-1", title: "dup" }] })).text.includes("already used"), "duplicate task keys across agents rejected");
  ok(!(await B.call("propose_subplan", { tasks: [
    { key: "be-1", title: "Auth API", milestone: "m1", paths: ["backend/src/auth/**"], acceptance: "POST /auth/login returns JWT" },
    { key: "be-2", title: "Listings API", milestone: "m2", depends_on: ["be-1"] },
  ] })).error, "backend subplan");
  ok(!(await A.call("submit_plan_for_review")).error, "lead submits plan for review");
  ok((await alice("POST", `${R}/plan/decision`, { approve: false, note: "add tests to acceptance" })).data.approved === false, "human requests changes");
  ok((await alice("GET", R)).data.room.phase === "planning", "back to planning");
  await A.call("submit_plan_for_review");
  ok((await bob("POST", `${R}/plan/decision`, { approve: true })).data.approved === true, "human approves plan");
  const tasks = (await alice("GET", `${R}/tasks`)).data;
  ok(tasks.length === 4 && (await alice("GET", R)).data.room.phase === "executing", "4 tasks materialized, phase executing");
  const num = (k: string) => tasks.find((t: any) => t.plan_key === k).number;
  const fe1 = tasks.find((t: any) => t.plan_key === "fe-1");
  ok(fe1.subtasks.length === 2 && fe1.blocked_by.includes(num("be-1")), "subtasks + cross-agent dependency preserved");
  ok((await alice("GET", `${R}/doc?path=/generated/plan.md`)).data.content.includes("Plan v1"), "plan rendered into /generated/plan.md");

  console.log("Phase 2b: execution");
  ok((await A.call("claim_task", { number: num("fe-1") })).text.includes("blocked by"), "cannot claim a blocked task");
  const cl = await B.call("claim_task", { number: num("be-1") });
  ok(cl.text.includes("Claimed paths: backend/src/auth/**"), "backend claims be-1 + its paths");
  ok((await A.call("claim_paths", { paths: ["backend/src/auth/routes.ts"] })).text.includes("overlap"), "path claim conflict detected");
  ctx = await A.call("get_context");
  ok(ctx.text.includes("Paths claimed by others") && ctx.text.includes("blocked"), "frontend context shows claims + blockers");

  console.log("Phase 3: ledger & channels");
  const pub = await B.call("publish", { kind: "api_change", title: "POST /auth/login returns {token, user}", affects: ["claude-fe"] });
  ok(!pub.error, "backend publishes api_change for frontend");
  const id = Number(/#(\d+)/.exec(pub.text)![1]);
  ctx = await A.call("get_context");
  ok(ctx.text.includes("must read and ack") && ctx.text.includes("/auth/login"), "frontend must ack the entry");
  let led = (await alice("GET", `${R}/ledger`)).data.find((l: any) => l.id === id);
  ok(led.pendingAck.includes("claude-fe"), "UI shows pending ack");
  await A.call("ack", { ids: [id] });
  led = (await alice("GET", `${R}/ledger`)).data.find((l: any) => l.id === id);
  ok(led.ackedBy.includes("claude-fe") && !led.pendingAck.length, "ack recorded");
  await A.call("read_messages");
  const waitP = A.call("wait_for_messages", { timeout_seconds: 10 });
  await sleep(300);
  await B.call("send_message", { to: "claude-fe", text: "token is in the Authorization header" });
  ok((await waitP).text.includes("Authorization header"), "DM delivered via wait_for_messages");
  await alice("POST", `${R}/messages`, { to: "cursor-be", body: "please add rate limiting" });
  ok((await B.call("read_messages")).text.includes("rate limiting"), "human → agent DM");
  await B.call("send_message", { channel: "general", text: "hi all" });
  ok(!(await A.call("read_messages")).text.includes("rate limiting"), "agents do not see other agents' DMs");
  await A.call("send_message", { to: "cursor-be", text: "inbox check" });
  const inbox = await (await fetch(`${H}/api/agent/${be.token}/inbox`)).text();
  ok(inbox.includes("Team room") && inbox.includes("inbox check"), "inbox hook endpoint returns new messages");

  console.log("Phase 4: GitHub");
  const repo = (await alice("POST", `${R}/repos`, { fullName: "acme/foodshare", apiToken: "test-token" })).data;
  ok(repo.webhookUrl && repo.secret, "repo connected, webhook URL + secret");
  ok(!JSON.stringify((await bob("GET", R)).data.repos).includes(repo.secret), "webhook secret hidden from non-owners");
  const hook = async (event: string, payload: any, secret = repo.secret) => {
    const body = JSON.stringify(payload);
    return fetch(`${H}/api/github/webhook/${repo.id}`, { method: "POST", headers: { "x-github-event": event, "x-hub-signature-256": sign(secret, body), "content-type": "application/json" }, body });
  };
  ok((await hook("ping", {}, "wrong")).status === 401, "bad webhook signature rejected");
  const n1 = num("be-1");
  prFiles["7"] = ["backend/src/auth/routes.ts", "shared/types.ts"];
  prFiles["8"] = ["frontend/src/x.tsx", "shared/types.ts"];
  const pr = (n: number, branch: string, extra: any = {}) => ({ number: n, title: `#${n1} auth`, html_url: `https://github.com/acme/foodshare/pull/${n}`, state: "open", head: { ref: branch, sha: `sha${n}` }, user: { login: "bob" }, body: "", ...extra });
  await hook("pull_request", { action: "opened", pull_request: pr(7, `room/${n1}-auth-api`) });
  ok((await alice("GET", `${R}/tasks`)).data.find((t: any) => t.number === n1).status === "review", "PR opened → task in review");
  await hook("pull_request", { action: "opened", pull_request: pr(8, "feature/x") });
  await sleep(200);
  const acts = (await alice("GET", `${R}/activity`)).data.map((a: any) => a.summary).join("\n");
  ok(acts.includes("Possible merge conflict") && acts.includes("shared/types.ts"), "conflicting files across PRs detected");
  await hook("pull_request_review", { action: "submitted", pull_request: pr(7, `room/${n1}-auth-api`), review: { state: "changes_requested", body: "hash passwords with bcrypt", user: { login: "alice" } } });
  await hook("check_suite", { action: "completed", check_suite: { conclusion: "failure", app: { name: "CI" }, pull_requests: [{ number: 7 }] } });
  const fb = await B.call("get_pr_feedback", { number: n1 });
  ok(fb.text.includes("bcrypt") && fb.text.includes("CI failure"), "review + CI feedback available to the agent");
  ok((await B.call("read_messages")).text.includes("bcrypt"), "feedback delivered to the task channel");
  const evA = agentEvents(fe.token);
  await sleep(200);
  await hook("pull_request", { action: "closed", pull_request: pr(7, `room/${n1}-auth-api`, { merged: true, merged_at: new Date().toISOString(), state: "closed" }) });
  await sleep(300);
  ok((await alice("GET", `${R}/tasks`)).data.find((t: any) => t.number === n1).status === "done", "PR merged → task done");
  ok(evA.events.some((e) => e.type === "wake" && /unblocked/.test(e.reason)), "frontend woken: its task is unblocked");
  ok(!(await A.call("claim_task", { number: num("fe-1") })).error, "frontend can now claim fe-1");

  // Polling sync (no webhook for this PR): the agent links it, it gets merged on GitHub, its tests fail.
  const n2 = num("be-2");
  pulls["9"] = { number: 9, title: "Listings API", html_url: "https://github.com/acme/foodshare/pull/9", state: "closed", merged_at: new Date().toISOString(),
    draft: false, head: { ref: "feature/listings", sha: "sha9" }, user: { login: "bob" }, body: "", created_at: new Date().toISOString() };
  checkRuns["sha9"] = [{ name: "unit", status: "completed", conclusion: "success" }, { name: "e2e", status: "completed", conclusion: "failure", output: { title: "2 tests failed" } }];
  await B.call("link_pr", { number: n2, url: "https://github.com/acme/foodshare/pull/9" });
  let p9: any;
  for (let i = 0; i < 30 && p9?.state !== "merged"; i++) { await sleep(100); p9 = (await alice("GET", `${R}/prs`)).data.find((p: any) => p.number === 9); }
  ok(p9.state === "merged" && p9.title === "Listings API" && p9.author === "bob", "polling sync: linked PR gets its real state from the GitHub API");
  ok(p9.ci_state === "failing" && p9.feedback.some((f: any) => f.body.includes("2 tests failed")), "polling sync: failing check runs → CI failing + feedback");
  ok((await alice("GET", `${R}/tasks`)).data.find((t: any) => t.number === n2).status === "done", "polling sync: merged PR marks the task done");
  await alice("POST", `${R}/repos`, { fullName: "acme/private" });
  await alice("POST", `${R}/prs/sync`);
  const repos = (await alice("GET", R)).data.repos;
  ok(repos.find((r: any) => r.full_name === "acme/private").sync_error === "not_found" && repos.find((r: any) => r.full_name === "acme/foodshare").webhook_at,
    "sync status per repo: unreadable repo reported, webhook deliveries tracked");

  console.log("Phase 5: plan changes, pause, revoke");
  const chg = await B.call("propose_plan_change", { title: "Add rate limiting", rationale: "Human asked", new_tasks: [{ key: "be-3", title: "Rate limit API", depends_on: [`#${n1}`] }] });
  ok(chg.text.includes("pending"), "plan change proposed");
  const lid = Number(/#(\d+)/.exec(chg.text)![1]);
  const dec = (await alice("POST", `${R}/ledger/${lid}/decision`, { approve: true })).data;
  ok(dec.created.length === 1, "human approves plan change → task created");
  const sub = await A.call("get_subagent_templates");
  ok(sub.text.includes(".claude/agents/test-writer.md"), "subagent templates for Claude Code");
  await alice("PATCH", `${R}/agents/${fe.agent.id}`, { paused: true });
  await sleep(150);
  ok(evA.events.some((e) => e.type === "paused"), "runner notified when agent is paused");
  await alice("POST", `${R}/agents/${fe.agent.id}/token`);
  const dead = await fetch(`${H}/mcp/${fe.token}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  ok(dead.status === 401, "reissued token revokes the old one");
  ok((await eve("GET", `${R}/ledger`)).status === 404 && (await eve("GET", `${R}/messages`)).status === 404, "eve still isolated from ledger and chat");
  evA.stop(); evB.stop();
  console.log(`\nAll ${passed} checks passed.`);
}

main().then(() => { cleanup(); process.exit(0); }).catch((e) => { console.error(e); cleanup(); process.exit(1); });
