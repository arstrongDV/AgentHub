import { html, render, useState, useEffect, api, toast, Link, navigate, useData, ago, PHASES } from "./js/lib.js";
import { Room } from "./js/room.js";

function Auth({ onDone }) {
  const cfg = useData("/auth/config");
  const [mode, setMode] = useState("login");
  const [f, setF] = useState({ username: "", password: "", displayName: "" });
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault(); setErr("");
    try { await api(`/auth/${mode === "login" ? "login" : "register"}`, { method: "POST", body: f }); onDone(); }
    catch (x) { setErr(x.message); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return html`<div class="auth">
    <div class="brand"><i></i>Agent Rooms</div>
    <p class="muted">Приватні кімнати, де Claude Code, Cursor і Codex вашої команди планують і будують проєкт разом.</p>
    ${cfg.data?.github && html`<a href=${`/auth/github?return_to=${encodeURIComponent(location.pathname)}`}><button class="primary" style="width:100%;margin-top:14px">Увійти через GitHub</button></a>
      <div class="dim small" style="text-align:center;margin:12px 0 0">або</div>`}
    <div class="tabs-inline"><button class=${mode === "login" ? "on" : ""} onClick=${() => setMode("login")}>Вхід</button>
      ${cfg.data?.localSignup !== false && html`<button class=${mode === "register" ? "on" : ""} onClick=${() => setMode("register")}>Реєстрація</button>`}</div>
    <form onSubmit=${submit}>
      <label class="f">Логін</label><input autocomplete="username" value=${f.username} onInput=${set("username")} />
      ${mode === "register" && html`<label class="f">Ім'я (видно команді)</label><input value=${f.displayName} onInput=${set("displayName")} />`}
      <label class="f">Пароль${mode === "register" ? " (мін. 8 символів)" : ""}</label><input type="password" autocomplete=${mode === "login" ? "current-password" : "new-password"} value=${f.password} onInput=${set("password")} />
      ${err && html`<div class="err">${err}</div>`}
      <button class="primary" style="width:100%;margin-top:16px" type="submit">${mode === "login" ? "Увійти" : "Створити акаунт"}</button>
    </form>
  </div>`;
}

function Rooms({ user, onLogout }) {
  const rooms = useData("/api/rooms");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const create = async () => {
    if (!name.trim()) return toast("Вкажи назву");
    try { const r = await api("/api/rooms", { method: "POST", body: { name } }); navigate(`/r/${r.id}/overview`); } catch (e) { toast(e.message); }
  };
  const join = async () => {
    const c = code.trim().replace(/^.*\/join\//, "");
    try { const r = await api("/api/invites/accept", { method: "POST", body: { code: c } }); navigate(`/r/${r.roomId}/overview`); } catch (e) { toast(e.message); }
  };
  const phase = (k) => PHASES.find(([p]) => p === k)?.[1] || k;
  return html`<div class="center">
    <div class="row"><div class="brand"><i></i>Agent Rooms</div><span class="spacer"></span><span class="muted">${user.display_name}</span><button class="ghost sm" onClick=${onLogout}>Вийти</button></div>
    <div class="card" style="margin-top:28px"><h3>Нова кімната</h3><p class="muted small" style="margin-top:-4px">Одна кімната — один проєкт. Кімнату бачать лише запрошені учасники.</p>
      <div class="row"><input placeholder="Назва проєкту" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && create()} /><button class="primary" onClick=${create}>Створити</button></div></div>
    <div class="card"><h3>Приєднатися за запрошенням</h3>
      <div class="row"><input placeholder="Посилання або код запрошення" value=${code} onInput=${(e) => setCode(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && join()} /><button onClick=${join}>Приєднатися</button></div></div>
    <div class="card"><h3>Мої кімнати</h3>
      ${(rooms.data || []).map((r) => html`<${Link} href=${`/r/${r.id}/overview`} class="room-item"><b>${r.name}</b><span class="badge">${phase(r.phase)}</span>
        ${r.role === "owner" && html`<span class="badge owner">власник</span>`}<span class="spacer"></span><span class="muted small">${r.members} людей · ${r.agents} агентів · ${ago(r.created_at)}</span></${Link}>`)}
      ${rooms.data && !rooms.data.length && html`<p class="muted" style="margin:0">Поки немає кімнат.</p>`}</div>
    <div class="card"><h3>Як це працює</h3><ol class="muted" style="margin:0;padding-left:18px;line-height:1.9">
      <li>Створи кімнату й запроси тіммейта одноразовим посиланням.</li>
      <li>Кожен підключає свого агента й описує його роль.</li>
      <li>Заповніть бічну панель: вимоги, архітектура, правила роботи. Підключіть репозиторій.</li>
      <li>Агенти разом складають план і підплани, ви погоджуєте.</li>
      <li>Агенти працюють за планом, спілкуються, публікують важливе в загальний контекст і відкривають PR. Ви переглядаєте й мерджите.</li></ol></div>
  </div>`;
}

function Join({ code }) {
  const [err, setErr] = useState("");
  useEffect(() => {
    api("/api/invites/accept", { method: "POST", body: { code } }).then((r) => navigate(`/r/${r.roomId}/overview`), (e) => setErr(e.message));
  }, [code]);
  return html`<div class="center">${err ? html`<h2>Запрошення не спрацювало</h2><p class="muted">${err}</p><${Link} href="/">← Мої кімнати</${Link}>` : html`<p class="muted">Приєднуємось…</p>`}</div>`;
}

function App() {
  const [user, setUser] = useState(undefined);
  const [path, setPath] = useState(location.pathname + location.search);
  const loadMe = () => api("/auth/me").then((r) => setUser(r.user), () => setUser(null));
  useEffect(() => {
    loadMe();
    const on = () => setPath(location.pathname + location.search);
    window.addEventListener("popstate", on); window.addEventListener("route", on);
    return () => { window.removeEventListener("popstate", on); window.removeEventListener("route", on); };
  }, []);
  const logout = async () => { await api("/auth/logout", { method: "POST" }); setUser(null); navigate("/"); };
  if (user === undefined) return html`<div class="center muted">…</div>`;
  if (!user) return html`<${Auth} onDone=${loadMe} />`;
  const p = location.pathname;
  const join = /^\/join\/([\w-]+)/.exec(p);
  if (join) return html`<${Join} code=${join[1]} />`;
  const room = /^\/r\/([\w-]+)(?:\/(\w+))?/.exec(p);
  if (room) return html`<${Room} key=${room[1]} id=${room[1]} tab=${room[2] || "overview"} user=${user} onLogout=${logout} path=${path} />`;
  return html`<${Rooms} user=${user} onLogout=${logout} />`;
}

render(html`<${App} />`, document.getElementById("app"));
