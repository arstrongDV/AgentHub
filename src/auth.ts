// Accounts, sessions, room membership checks. Local accounts always work; GitHub OAuth if configured.
import crypto from "node:crypto";
import type { Request, Response, NextFunction, Express } from "express";
import { db, now } from "./db.js";

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");
export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString("base64url");

const SESSION_COOKIE = "ar_session";
const SESSION_DAYS = 30;
export const GITHUB_ENABLED = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
export const LOCAL_SIGNUP = process.env.ALLOW_LOCAL_SIGNUP !== "false";

export type User = { id: string; username: string; display_name: string; avatar_url: string | null; github_id: string | null };
export type Member = { room_id: string; user_id: string; role: "owner" | "member" };

declare global {
  namespace Express {
    interface Request { user?: User; member?: Member }
  }
}

// ---------- passwords ----------
function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(pw: string, stored: string | null) {
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split("$");
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

// ---------- sessions ----------
function createSession(res: Response, req: Request<any>, userId: string) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3);
  db.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?,?,?)").run(sha256(token), userId, expires.toISOString());
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: req.secure, expires, path: "/",
  });
}

export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const row = db.prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.github_id, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`
    ).get(sha256(token)) as any;
    if (row && row.expires_at > now()) {
      delete row.expires_at;
      req.user = row;
    }
  }
  next();
}

// CSRF protection: cookie-authenticated mutations must carry a custom header,
// which browsers never send cross-site without a CORS preflight (and we allow no CORS).
export function csrf(req: Request<any>, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-requested-with") !== "agent-rooms") return res.status(403).json({ error: "missing CSRF header" });
  next();
}

export function requireUser(req: Request<any>, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "not signed in" });
  next();
}

// Room isolation: every /api/rooms/:roomId/* route goes through this. It never trusts the body.
// Non-members get 404 (not 403) so they cannot even learn that a room exists.
export function requireMember(req: Request<any>, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "not signed in" });
  const m = db.prepare("SELECT * FROM room_members WHERE room_id = ? AND user_id = ?").get(req.params.roomId, req.user.id) as Member | undefined;
  if (!m) return res.status(404).json({ error: "room not found" });
  req.member = m;
  next();
}
export function requireOwner(req: Request<any>, res: Response, next: NextFunction) {
  if (req.member?.role !== "owner") return res.status(403).json({ error: "only the room owner can do this" });
  next();
}

// ---------- brute-force guard ----------
const attempts = new Map<string, { n: number; until: number }>();
function tooMany(key: string) {
  const a = attempts.get(key);
  return a && a.n >= 8 && a.until > Date.now();
}
function fail(key: string) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1; a.until = Date.now() + 10 * 60e3;
  attempts.set(key, a);
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,32}$/;

export function authRoutes(app: Express) {
  app.get("/auth/config", (req, res) => res.json({ github: GITHUB_ENABLED, localSignup: LOCAL_SIGNUP }));

  app.get("/auth/me", (req, res) => res.json({ user: req.user || null }));

  app.post("/auth/register", csrf, (req, res) => {
    if (!LOCAL_SIGNUP) return res.status(403).json({ error: "local sign-up is disabled, use GitHub" });
    const { username, password, displayName } = req.body || {};
    if (!USERNAME_RE.test(username || "")) return res.status(400).json({ error: "username: 2–32 chars, letters/digits/._-" });
    if (!password || String(password).length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return res.status(409).json({ error: "username is taken" });
    const id = newId();
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)")
      .run(id, username, String(displayName || username).slice(0, 40), hashPassword(String(password)), now());
    createSession(res, req, id);
    res.json({ ok: true });
  });

  app.post("/auth/login", csrf, (req, res) => {
    const { username, password } = req.body || {};
    const key = `${req.ip}|${String(username).toLowerCase()}`;
    if (tooMany(key)) return res.status(429).json({ error: "too many attempts, try again in 10 minutes" });
    const u = db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(username || "") as any;
    if (!u || !verifyPassword(String(password || ""), u.password_hash)) {
      fail(key);
      return res.status(401).json({ error: "wrong username or password" });
    }
    attempts.delete(key);
    createSession(res, req, u.id);
    res.json({ ok: true });
  });

  app.post("/auth/logout", csrf, (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(token));
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // ----- GitHub OAuth -----
  app.get("/auth/github", (req, res) => {
    if (!GITHUB_ENABLED) return res.status(404).send("GitHub login is not configured");
    const state = randomToken(16);
    const returnTo = typeof req.query.return_to === "string" && req.query.return_to.startsWith("/") ? req.query.return_to : "/";
    res.cookie("ar_oauth", JSON.stringify({ state, returnTo }), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 10 * 60e3 });
    const redirect = `${publicUrl(req)}/auth/github/callback`;
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
    u.searchParams.set("redirect_uri", redirect);
    u.searchParams.set("scope", "read:user");
    u.searchParams.set("state", state);
    res.redirect(u.toString());
  });

  app.get("/auth/github/callback", async (req, res) => {
    try {
      const saved = JSON.parse(req.cookies?.ar_oauth || "{}");
      res.clearCookie("ar_oauth");
      if (!saved.state || saved.state !== req.query.state) return res.status(400).send("OAuth state mismatch, try again");
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET,
          code: req.query.code, redirect_uri: `${publicUrl(req)}/auth/github/callback`,
        }),
      });
      const tok = (await tokenRes.json()) as any;
      if (!tok.access_token) return res.status(400).send("GitHub did not return a token");
      const gh = (await (await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": "agent-rooms" },
      })).json()) as any;
      if (!gh.id) return res.status(400).send("Could not read GitHub profile");
      let user = db.prepare("SELECT id FROM users WHERE github_id = ?").get(String(gh.id)) as any;
      if (!user) {
        let username = gh.login;
        if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) username = `${gh.login}-gh`;
        const id = newId();
        db.prepare("INSERT INTO users (id, username, display_name, github_id, avatar_url, created_at) VALUES (?,?,?,?,?,?)")
          .run(id, username, gh.name || gh.login, String(gh.id), gh.avatar_url || null, now());
        user = { id };
      } else {
        db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(gh.avatar_url || null, user.id);
      }
      createSession(res, req, user.id);
      res.redirect(saved.returnTo || "/");
    } catch (e: any) {
      console.error(e);
      res.status(500).send("GitHub login failed");
    }
  });
}

export function publicUrl(req: Request<any>) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}
