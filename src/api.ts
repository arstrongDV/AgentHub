// REST API for the web UI. Every room route is behind requireMember (room isolation).
import express, { type Express, type Request, type Response } from "express";
import { db } from "./db.js";
import { requireUser, requireMember, requireOwner, csrf, publicUrl } from "./auth.js";
import * as C from "./core.js";
import * as P from "./planning.js";
import * as G from "./github.js";
import { pointerFile, cursorPointer } from "./templates.js";

const human = (req: Request<any>): C.Actor => ({ kind: "human", name: req.user!.display_name, userId: req.user!.id });
const h = (fn: (req: Request<any>, res: Response) => any) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e: any) {
    if (e instanceof C.AppError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
};

export function apiRoutes(app: Express) {
  const r = express.Router();
  r.use(csrf, requireUser);

  // ----- rooms -----
  r.get("/rooms", h((req) => C.listUserRooms(req.user!.id)));
  r.post("/rooms", h((req) => C.createRoom(req.user!.id, req.user!.display_name, req.body?.name)));
  r.post("/invites/accept", h((req) => ({ roomId: C.acceptInvite(req.body?.code, req.user!.id, req.user!.display_name) })));

  const room = express.Router({ mergeParams: true });
  room.use(requireMember);
  r.use("/rooms/:roomId", room);

  room.get("/", h((req) => {
    const id = req.params.roomId;
    const rm = C.getRoom(id)!;
    const members = C.roomMembers(id);
    const owners = new Map(members.map((m) => [m.id, m.display_name]));
    const isOwner = req.member!.role === "owner";
    return {
      room: rm,
      me: { ...req.user, role: req.member!.role },
      members,
      agents: C.agentsOf(id).map((a) => ({ ...C.publicAgent(a), owner: owners.get(a.owner_user_id) || "?", mine: a.owner_user_id === req.user!.id })),
      repos: G.reposOf(id, isOwner),
      claims: C.claimsOf(id),
      milestones: P.milestonesOf(id),
      hubUrl: publicUrl(req),
    };
  }));
  room.patch("/", requireOwner, h((req) => {
    const name = String(req.body?.name || "").trim();
    if (name) db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(name.slice(0, 100), req.params.roomId);
    C.roomChanged(req.params.roomId, "room");
  }));
  room.delete("/", requireOwner, h((req) => { db.prepare("DELETE FROM rooms WHERE id = ?").run(req.params.roomId); }));

  // ----- members & invites -----
  room.post("/invites", requireOwner, h((req) => C.createInvite(req.params.roomId, human(req) as any, Math.min(168, Math.max(1, Number(req.body?.hours) || 24)))));
  room.delete("/members/:userId", requireOwner, h((req) => C.removeMember(req.params.roomId, req.params.userId, human(req))));
  room.post("/leave", h((req) => {
    if (req.member!.role === "owner") C.fail("the owner cannot leave; delete the room instead");
    C.removeMember(req.params.roomId, req.user!.id, human(req));
  }));

  // ----- agents -----
  const canManageAgent = (req: Request<any>) => {
    const a = C.agentById(req.params.roomId, req.params.agentId) || C.fail("agent not found", 404);
    if (a.owner_user_id !== req.user!.id && req.member!.role !== "owner") C.fail("only the agent's owner can do this", 403);
    return a;
  };
  room.post("/agents", h((req) => C.createAgent(req.params.roomId, human(req) as any, req.body || {})));
  room.patch("/agents/:agentId", h((req) => { canManageAgent(req); return C.updateAgent(req.params.roomId, req.params.agentId, human(req), req.body || {}); }));
  room.post("/agents/:agentId/token", h((req) => { canManageAgent(req); return { token: C.reissueToken(req.params.roomId, req.params.agentId, human(req)) }; }));
  room.delete("/agents/:agentId", h((req) => { canManageAgent(req); C.deleteAgent(req.params.roomId, req.params.agentId, human(req)); }));
  room.put("/lead", h((req) => P.setLead(req.params.roomId, req.body?.agentId || null, human(req))));

  // ----- phases & plan -----
  room.post("/phase/start-planning", h((req) => P.startPlanning(req.params.roomId, human(req))));
  room.post("/phase", requireOwner, h((req) => {
    const phase = req.body?.phase;
    if (!["setup", "executing", "done"].includes(phase)) C.fail("phase can be set manually only to setup, executing or done");
    if (phase === "executing" && !P.approvedPlan(req.params.roomId)) C.fail("approve a plan first");
    P.setPhase(req.params.roomId, phase, human(req));
  }));
  room.get("/plan", h((req) => P.planView(req.params.roomId, req.query.id ? Number(req.query.id) : undefined)));
  room.post("/plan/comments", h((req) => P.commentPlan(req.params.roomId, human(req), req.body?.body)));
  room.post("/plan/decision", h((req) => P.decidePlan(req.params.roomId, human(req), !!req.body?.approve, String(req.body?.note || ""))));

  // ----- tasks -----
  room.get("/tasks", h((req) => P.listTasks(req.params.roomId)));
  room.post("/tasks", h((req) => ({ number: P.createTask(req.params.roomId, human(req), req.body || {}) })));
  room.patch("/tasks/:number", h((req) => P.updateTask(req.params.roomId, human(req), Number(req.params.number), req.body || {})));
  room.delete("/tasks/:number", h((req) => P.deleteTask(req.params.roomId, human(req), Number(req.params.number))));
  room.post("/tasks/:number/subtasks", h((req) => P.addSubtasks(req.params.roomId, human(req), Number(req.params.number), req.body?.subtasks || [])));
  room.patch("/subtasks/:id", h((req) => P.checkSubtask(req.params.roomId, human(req), Number(req.params.id), !!req.body?.done)));

  // ----- docs -----
  room.get("/docs", h((req) => C.listDocs(req.params.roomId)));
  room.get("/doc", h((req) => C.getDoc(req.params.roomId, C.normDocPath(String(req.query.path))) || C.fail("not found", 404)));
  room.put("/doc", h((req) => C.writeDoc(req.params.roomId, req.body?.path, req.body?.content, human(req), { memberRole: req.member!.role, baseVersion: req.body?.baseVersion })));
  room.delete("/doc", h((req) => C.deleteDoc(req.params.roomId, String(req.query.path), human(req), req.member!.role)));
  room.get("/doc/versions", h((req) => C.docVersions(req.params.roomId, C.normDocPath(String(req.query.path)))));
  room.get("/doc/version", h((req) => C.docVersion(req.params.roomId, C.normDocPath(String(req.query.path)), Number(req.query.v)) || C.fail("not found", 404)));
  room.get("/pointer", h((req, res) => {
    const rm = C.getRoom(req.params.roomId)!;
    res.type("text/markdown").send(req.query.format === "cursor" ? cursorPointer(rm.name) : pointerFile(rm.name));
  }));

  // ----- ledger -----
  room.get("/ledger", h((req) => C.ledgerList(req.params.roomId)));
  room.post("/ledger", h((req) => ({ id: C.publish(req.params.roomId, human(req), req.body || {}) })));
  room.post("/ledger/:id/decision", h((req) => P.decidePlanChange(req.params.roomId, Number(req.params.id), human(req), !!req.body?.approve)));
  room.patch("/ledger/:id", h((req) => {
    const st = req.body?.status;
    if (!["active", "resolved"].includes(st)) C.fail("status must be active or resolved");
    db.prepare("UPDATE ledger SET status = ? WHERE id = ? AND room_id = ? AND kind != 'plan_change'").run(st, Number(req.params.id), req.params.roomId);
    C.roomChanged(req.params.roomId, "ledger");
  }));

  // ----- messages -----
  room.get("/channels", h((req) => {
    const me = `user:${req.user!.id}`;
    const rows = db.prepare(
      `SELECT channel, MAX(id) AS last_id, COUNT(*) AS n FROM messages WHERE room_id = ? GROUP BY channel ORDER BY last_id DESC`
    ).all(req.params.roomId) as any[];
    return rows.map((r) => ({ ...r, label: C.channelLabel(req.params.roomId, r.channel, me), mine: r.channel.includes(me) }));
  }));
  room.get("/messages", h((req) => {
    const ch = String(req.query.channel || "general");
    return C.channelHistory(req.params.roomId, ch, Math.min(200, Number(req.query.limit) || 100), req.query.before ? Number(req.query.before) : undefined);
  }));
  room.post("/messages", h((req) => {
    const id = req.params.roomId;
    let ch = String(req.body?.channel || "general");
    if (req.body?.to) ch = C.dmChannel(`user:${req.user!.id}`, C.resolveParticipant(id, req.body.to).ref);
    return C.postMessage(id, human(req), ch, req.body?.body);
  }));

  // ----- activity -----
  room.get("/activity", h((req) => {
    const before = req.query.before ? Number(req.query.before) : null;
    return db.prepare(`SELECT * FROM activity WHERE room_id = ? ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT 150`)
      .all(...(before ? [req.params.roomId, before] : [req.params.roomId]));
  }));

  // ----- repos & PRs -----
  room.get("/prs", h((req) => G.prsOf(req.params.roomId)));
  room.post("/repos", requireOwner, h((req) => {
    const out = G.addRepo(req.params.roomId, human(req), req.body?.fullName, req.body?.apiToken, req.body?.defaultBranch);
    return { ...out, webhookUrl: `${publicUrl(req)}/api/github/webhook/${out.id}` };
  }));
  room.patch("/repos/:repoId", requireOwner, h((req) => G.updateRepo(req.params.roomId, req.params.repoId, req.body || {})));
  room.delete("/repos/:repoId", requireOwner, h((req) => G.deleteRepo(req.params.roomId, req.params.repoId, human(req))));

  // ----- live updates (SSE), scoped to this room -----
  room.get("/events", (req: Request<any>, res: Response) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": ok\n\n");
    const id = req.params.roomId;
    const userId = req.user!.id;
    const onRoom = (ev: any) => {
      if (ev.roomId !== id) return;
      // membership may have been revoked meanwhile
      if (!db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?").get(id, userId)) { res.end(); return; }
      res.write(`data: ${JSON.stringify({ type: ev.type })}\n\n`);
    };
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    C.bus.on("room", onRoom);
    req.on("close", () => { clearInterval(ping); C.bus.off("room", onRoom); });
  });

  app.use("/api", r);
}
