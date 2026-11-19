import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import "./db.js";
import { loadUser, authRoutes, GITHUB_ENABLED } from "./auth.js";
import { apiRoutes } from "./api.js";
import * as C from "./core.js";
import { handleWebhook } from "./github.js";
import { buildMcpServer } from "./mcp.js";
import { pointerFile, cursorPointer } from "./templates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4000);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "false" ? false : 1);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// GitHub webhooks need the raw body for signature verification.
app.post("/api/github/webhook/:repoId", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
  try {
    const out = await handleWebhook(req.params.repoId, String(req.get("x-github-event") || ""), req.body as Buffer, req.get("x-hub-signature-256"));
    res.json(out);
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(loadUser);
// ---------------- agent endpoints (authenticated by agent token) ----------------
const agentFromToken = (token: string) => C.agentByToken(token);

app.post("/mcp/:token", async (req, res) => {
  const agent = agentFromToken(req.params.token);
  if (!agent) return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Invalid or revoked room token" }, id: null });
  try {
    const server = buildMcpServer(agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP error", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
const mcpNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get("/mcp/:token", mcpNotAllowed);
app.delete("/mcp/:token", mcpNotAllowed);

// Claude Code UserPromptSubmit hook: prints new messages + pending ledger entries (or nothing).
app.get("/api/agent/:token/inbox", (req, res) => {
  const a = agentFromToken(req.params.token);
  if (!a) return res.status(401).type("text/plain").send("");
  const msgs = C.unreadForAgent(a, 30);
  const ledger = C.unackedFor(a);
  if (msgs.length) C.markRead(a, msgs[msgs.length - 1].id);
  if (!msgs.length && !ledger.length) return res.type("text/plain").send("");
  const viewer = `agent:${a.id}`;
  const out = [`[Team room — you are ${a.name}]`];
  if (ledger.length) out.push(`Ledger entries to read and ack (call get_context): ${ledger.map((l: any) => `#${l.id} ${l.kind}: ${l.title}`).join("; ")}`);
  if (msgs.length) out.push("New messages:", ...msgs.map((m: any) => `- [${C.channelLabel(a.room_id, m.channel, viewer)}] ${m.author}: ${m.body}`));
  res.type("text/plain").send(out.join("\n") + "\n");
});

app.get("/api/agent/:token/pointer", (req, res) => {
  const a = agentFromToken(req.params.token);
  if (!a) return res.status(401).type("text/plain").send("invalid token");
  const room = C.getRoom(a.room_id)!;
  res.type("text/markdown").send(req.query.format === "cursor" ? cursorPointer(room.name) : pointerFile(room.name));
});

// Runner wake-up stream: only events that should make THIS agent act.
app.get("/api/agent/:token/events", (req, res) => {
  const a = agentFromToken(req.params.token);
  if (!a) return res.status(401).type("text/plain").send("invalid token");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const room = C.getRoom(a.room_id)!;
  send({ type: "hello", room: room.name, you: a.name, agentType: a.agent_type, paused: !!a.paused, phase: room.phase,
    pending: C.unreadCount(a) + C.unackedFor(a).length });
  const onWake = (ev: any) => {
    if (ev.roomId !== a.room_id || !ev.agentIds.includes(a.id)) return;
    const fresh = C.agentById(a.room_id, a.id);
    if (!fresh || fresh.paused) return;
    send({ type: "wake", reason: ev.reason, task: ev.task ?? null, channel: ev.channel ?? null });
  };
  const onPause = (ev: any) => { if (ev.agentId === a.id) send({ type: ev.paused ? "paused" : "resumed" }); };
  const onRevoke = (ev: any) => { if (ev.agentId === a.id) { send({ type: "revoked" }); res.end(); } };
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  C.bus.on("wake", onWake); C.bus.on("pause", onPause); C.bus.on("revoke", onRevoke);
  C.runnerConnected(a.room_id, a.id, 1);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping); C.bus.off("wake", onWake); C.bus.off("pause", onPause); C.bus.off("revoke", onRevoke);
    C.runnerConnected(a.room_id, a.id, -1);
  };
  req.on("close", cleanup); res.on("close", cleanup);
});

// Agent endpoints above are token-authenticated; the session-authenticated API comes after them.
authRoutes(app);
apiRoutes(app);

// ---------------- static UI ----------------
app.use("/vendor/preact.mjs", express.static(path.join(root, "node_modules/preact/dist/preact.mjs")));
app.use("/vendor/hooks.mjs", express.static(path.join(root, "node_modules/preact/hooks/dist/hooks.mjs")));
app.use("/vendor/htm.mjs", express.static(path.join(root, "node_modules/htm/dist/htm.mjs")));
app.use(express.static(path.join(root, "public"), { index: false }));
app.get(/^\/(?!api\/|mcp\/|auth\/).*/, (_req, res) => res.sendFile(path.join(root, "public/index.html")));

app.listen(PORT, () => {
  console.log(`agent-rooms v2 on http://localhost:${PORT}`);
  console.log(`login: local accounts${GITHUB_ENABLED ? " + GitHub OAuth" : " (set GITHUB_CLIENT_ID/SECRET to enable GitHub login)"}`);
});
