import { html, useState, useEffect, useRef, api, toast, tryToast, Modal, Link, navigate, useData, ago, time, activity, copy, Code,
  Markdown, lineDiff, AGENT_TYPES, PHASES, STATUS, KINDS } from "./lib.js";
import { AgentSetup, AgentEdit, CreateAgent } from "./agents.js";

const TABS = [["overview", "Огляд"], ["plan", "План"], ["tasks", "Задачі"], ["ledger", "Загальний контекст"], ["chat", "Чат"], ["activity", "Активність"], ["prs", "PR"], ["settings", "Налаштування"]];

export function Room({ id, tab, user, onLogout }) {
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  const meta = useData(`/api/rooms/${id}`, [tick]);
  const ledger = useData(`/api/rooms/${id}/ledger`, [tick]);
  useEffect(() => {
    const es = new EventSource(`/api/rooms/${id}/events`);
    let t;
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = () => { clearTimeout(t); t = setTimeout(() => setTick((x) => x + 1), 150); };
    const iv = setInterval(() => setTick((x) => x + 1), 60000); // refresh "x min ago"
    return () => { es.close(); clearInterval(iv); };
  }, [id]);

  if (meta.error) return html`<div class="center"><h2>Кімнату не знайдено</h2><p class="muted">Або її не існує, або ти не учасник. Попроси власника кімнати про запрошення.</p><${Link} href="/">← Мої кімнати</${Link}></div>`;
  if (!meta.data) return html`<div class="center muted">Завантаження…</div>`;
  const m = meta.data;
  const phaseIdx = PHASES.findIndex(([k]) => k === m.room.phase);
  const pendingChanges = (ledger.data || []).filter((l) => l.kind === "plan_change" && l.status === "pending").length;
  const docPath = tab === "doc" ? new URLSearchParams(location.search).get("path") : null;
  const ctx = { id, m, tick, user, refresh: () => setTick((x) => x + 1), ledger: ledger.data || [] };

  return html`<div class="room">
    <div class="topbar">
      <${Link} href="/" class="ghost" title="Мої кімнати">←</${Link}>
      <span class="name">${m.room.name}</span>
      <span class=${`dot ${live ? "active" : ""}`} title=${live ? "Live" : "Немає з'єднання"}></span>
      <div class="phases">${PHASES.map(([k, label], i) => html`${i > 0 && html`<span class="sep">›</span>`}<span class=${`phase ${i < phaseIdx ? "done" : i === phaseIdx ? "now" : ""}`}>${label}</span>`)}</div>
      <span class="spacer"></span>
      <span class="muted small">${user.display_name}${m.me.role === "owner" ? html` <span class="badge owner">власник</span>` : ""}</span>
      <button class="ghost sm" onClick=${onLogout}>Вийти</button>
    </div>
    <div class="tabs">${TABS.map(([k, label]) => html`<${Link} href=${`/r/${id}/${k}`} class=${tab === k ? "on" : ""}>${label}
      ${k === "plan" && m.room.phase === "plan_review" ? html`<span class="count">!</span>` : ""}
      ${k === "ledger" && pendingChanges ? html`<span class="count">${pendingChanges}</span>` : ""}</${Link}>`)}</div>
    <div class="room-body">
      <${Sidebar} ...${ctx} active=${docPath} />
      <div class=${`main ${tab === "chat" ? "flush" : ""}`}>
        ${tab === "overview" && html`<${Overview} ...${ctx} />`}
        ${tab === "plan" && html`<${Plan} ...${ctx} />`}
        ${tab === "tasks" && html`<${Tasks} ...${ctx} />`}
        ${tab === "ledger" && html`<${Ledger} ...${ctx} />`}
        ${tab === "chat" && html`<${Chat} ...${ctx} />`}
        ${tab === "activity" && html`<${Activity} ...${ctx} />`}
        ${tab === "prs" && html`<${PRs} ...${ctx} />`}
        ${tab === "settings" && html`<${Settings} ...${ctx} />`}
        ${tab === "doc" && docPath && html`<${DocView} key=${docPath} ...${ctx} path=${docPath} />`}
      </div>
    </div>
  </div>`;
}

// ====================== SIDEBAR: knowledge base ======================
function Sidebar({ id, tick, m, active }) {
  const docs = useData(`/api/rooms/${id}/docs`, [tick]);
  const [creating, setCreating] = useState(null);
  const fileInput = useRef();
  const list = docs.data || [];
  const group = (prefix) => list.filter((d) => d.path.startsWith(prefix));
  const open = (p) => navigate(`/r/${id}/doc?path=${encodeURIComponent(p)}`);
  const item = (d, sub) => html`<div class=${`file ${sub ? "sub" : ""} ${active === d.path ? "on" : ""}`} onClick=${() => open(d.path)} title=${d.path}>
    <span>📄</span><span class="p">${d.path.split("/").pop()}</span><span class="v">v${d.version}</span></div>`;
  const upload = async (e) => {
    for (const file of e.target.files) {
      const text = await file.text();
      const name = file.name.replace(/[^\w.-]+/g, "-");
      try { await api(`/api/rooms/${id}/doc`, { method: "PUT", body: { path: `/team/${name}`, content: text } }); toast(`Завантажено /team/${name}`); }
      catch (err) { toast(err.message); }
    }
    e.target.value = "";
  };
  const agentNames = [...new Set(group("/agents/").map((d) => d.path.split("/")[2]))];
  return html`<div class="sidebar">
    <div class="sb-h">Команда<span class="spacer"></span>
      <button class="ghost sm" title="Завантажити .md файли" onClick=${() => fileInput.current.click()}>⇪</button>
      <button class="ghost sm" title="Новий документ" onClick=${() => setCreating("/team/")}>＋</button></div>
    <input type="file" accept=".md,.txt,.json,.yml,.yaml" multiple style="display:none" ref=${fileInput} onChange=${upload} />
    <div class="sb-hint">Вимоги, архітектура, правила роботи. Редагують люди, агенти читають.</div>
    ${group("/team/").filter((d) => !d.path.startsWith("/team/subagents/")).map((d) => item(d))}
    ${group("/team/subagents/").length > 0 && html`<div class="file dim small" style="cursor:default">субагенти</div>${group("/team/subagents/").map((d) => item(d, true))}`}
    <div class="sb-h">Агенти</div>
    <div class="sb-hint">Профіль кожного агента — пише його власник.</div>
    ${agentNames.map((n) => group(`/agents/${n}/`).map((d) => html`<div class=${`file ${active === d.path ? "on" : ""}`} onClick=${() => open(d.path)}>
      <span>🤖</span><span class="p">${n}${d.path.endsWith("/profile.md") ? "" : " / " + d.path.split("/").pop()}</span><span class="v">v${d.version}</span></div>`))}
    ${!agentNames.length && html`<div class="sb-hint">Ще немає агентів.</div>`}
    <div class="sb-h">Згенеровано агентами<span class="spacer"></span><button class="ghost sm" onClick=${() => setCreating("/generated/")}>＋</button></div>
    ${group("/generated/").map((d) => item(d))}
    ${creating && html`<${NewDoc} id=${id} prefix=${creating} onClose=${() => setCreating(null)} onDone=${(p) => { setCreating(null); open(p); }} />`}
  </div>`;
}

function NewDoc({ id, prefix, onClose, onDone }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const go = async () => {
    try { const r = await api(`/api/rooms/${id}/doc`, { method: "PUT", body: { path: prefix + name, content: `# ${name.replace(/\.md$/, "")}\n` } }); onDone(r.path); }
    catch (e) { setErr(e.message); }
  };
  return html`<${Modal} onClose=${onClose}><h2>Новий документ</h2>
    <label class="f">Шлях</label><div class="row"><code>${prefix}</code><input autofocus value=${name} placeholder="testing.md" onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && go()} /></div>
    ${err && html`<div class="err">${err}</div>`}
    <div class="actions"><button onClick=${onClose}>Скасувати</button><button class="primary" onClick=${go}>Створити</button></div></${Modal}>`;
}

// ====================== DOC VIEW / EDITOR ======================
function DocView({ id, path, tick, m }) {
  const doc = useData(`/api/rooms/${id}/doc?path=${encodeURIComponent(path)}`, [tick]);
  const versions = useData(`/api/rooms/${id}/doc/versions?path=${encodeURIComponent(path)}`, [tick]);
  const [mode, setMode] = useState("view");
  const [draft, setDraft] = useState(null);
  const [base, setBase] = useState(null);
  const [diff, setDiff] = useState(null);
  if (doc.error) return html`<div class="empty">${doc.error}</div>`;
  if (!doc.data) return html`<div class="muted">…</div>`;
  const d = doc.data;
  const agentMatch = /^\/agents\/([^/]+)\//.exec(path);
  const ownerAgent = agentMatch && m.agents.find((a) => a.name.toLowerCase() === agentMatch[1].toLowerCase());
  const canEdit = path.startsWith("/team/") || path.startsWith("/generated/") || (ownerAgent ? ownerAgent.mine || m.me.role === "owner" : m.me.role === "owner");
  const edit = () => { setDraft(d.content); setBase(d.version); setMode("edit"); };
  const save = tryToast(async () => {
    await api(`/api/rooms/${id}/doc`, { method: "PUT", body: { path, content: draft, baseVersion: base } });
    toast("Збережено"); setMode("view");
  });
  const showDiff = tryToast(async (v) => {
    if (!v) return setDiff(null);
    const prev = await api(`/api/rooms/${id}/doc/version?path=${encodeURIComponent(path)}&v=${v}`);
    setDiff({ v, lines: lineDiff(prev.content, d.content) });
  });
  const del = tryToast(async () => { if (!confirm(`Видалити ${path}?`)) return; await api(`/api/rooms/${id}/doc?path=${encodeURIComponent(path)}`, { method: "DELETE" }); navigate(`/r/${id}/overview`); });
  const area = path.startsWith("/team/") ? "Спільний документ команди — агенти читають його через get_context."
    : path.startsWith("/agents/") ? `Профіль агента. Редагує лише власник агента${ownerAgent ? ` (${ownerAgent.owner})` : ""}.`
    : "Документ, який ведуть агенти (вони теж можуть його змінювати).";
  return html`<div>
    <div class="doc-h"><h2>${path}</h2><span class="badge">v${d.version}</span><span class="muted small">${d.updated_by} · ${ago(d.updated_at)}</span><span class="spacer"></span>
      ${mode === "view" && html`
        <select style="width:auto" onChange=${(e) => showDiff(Number(e.target.value))}><option value="">Порівняти з версією…</option>
          ${(versions.data || []).filter((v) => v.version !== d.version).map((v) => html`<option value=${v.version}>v${v.version} · ${v.updated_by} · ${ago(v.created_at)}</option>`)}</select>
        ${canEdit && html`<button class="primary" onClick=${edit}>Редагувати</button>`}
        ${canEdit && path !== "/team/workflow.md" && html`<button class="ghost danger" onClick=${del}>Видалити</button>`}`}
      ${mode === "edit" && html`<button onClick=${() => setMode("view")}>Скасувати</button><button class="primary" onClick=${save}>Зберегти</button>`}
    </div>
    <p class="muted small" style="margin-top:-4px">${area}${!canEdit ? " Тобі доступний лише перегляд." : ""}</p>
    ${mode === "edit" && html`<textarea class="editor" value=${draft} onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } }}></textarea>`}
    ${mode === "view" && diff && html`<div class="row" style="margin-bottom:8px"><b>Зміни v${diff.v} → v${d.version}</b><button class="ghost sm" onClick=${() => setDiff(null)}>✕</button></div>
      <div class="diff">${diff.lines.map((l) => html`<div class=${l.t}>${l.t === "add" ? "+ " : l.t === "del" ? "− " : "  "}${l.s}</div>`)}</div>`}
    ${mode === "view" && !diff && html`<div class="card"><${Markdown} text=${d.content} /></div>`}
  </div>`;
}

// ====================== OVERVIEW ======================
function Overview({ id, m, tick, refresh, ledger }) {
  const tasks = useData(`/api/rooms/${id}/tasks`, [tick]);
  const docs = useData(`/api/rooms/${id}/docs`, [tick]);
  const [creating, setCreating] = useState(false);
  const [setup, setSetup] = useState(null);
  const [editing, setEditing] = useState(null);
  const phase = m.room.phase;
  const docSize = (p) => (docs.data || []).find((d) => d.path === p);
  const reqDone = (docSize("/team/requirements.md")?.version || 1) > 1;
  const archDone = (docSize("/team/architecture.md")?.version || 1) > 1;
  const lead = m.agents.find((a) => a.id === m.room.lead_agent_id);
  const startPlanning = tryToast(async () => { await api(`/api/rooms/${id}/phase/start-planning`, { method: "POST" }); toast("Планування почалося"); });
  const setLead = tryToast(async (agentId) => { await api(`/api/rooms/${id}/lead`, { method: "PUT", body: { agentId } }); });
  const all = tasks.data || [];
  const pendingAcks = ledger.filter((l) => l.pendingAck?.length && l.status !== "resolved").slice(0, 5);
  const pendingChanges = ledger.filter((l) => l.kind === "plan_change" && l.status === "pending");
  const checks = [
    [m.members.length > 1, "Тіммейти в кімнаті", "settings"],
    [m.agents.length > 0, "Агенти підключені", null],
    [m.agents.some((a) => a.last_seen), "Хоча б один агент вийшов на зв'язок", null],
    [reqDone, "Вимоги заповнені (/team/requirements.md)", `doc?path=/team/requirements.md`],
    [archDone, "Архітектура описана (/team/architecture.md)", `doc?path=/team/architecture.md`],
    [m.repos.length > 0, "Репозиторій підключено", "settings"],
    [!!lead, "Обрано lead-агента (складає загальний план)", null],
  ];
  return html`<div class="ov">
    <div>
      ${phase === "setup" && html`<div class="callout"><h3>Підготовка кімнати</h3>
        <div>${checks.map(([ok, label, link]) => html`<div class=${`check ${ok ? "yes" : ""}`}><span class="ic">${ok ? "✓" : ""}</span>${link ? html`<${Link} href=${`/r/${id}/${link}`}>${label}</${Link}>` : label}</div>`)}</div>
        <div class="row" style="margin-top:12px"><button class="primary" disabled=${!lead} onClick=${startPlanning}>Почати планування</button>
          <span class="muted small">${lead ? `Lead: ${lead.name} складе загальний план, кожен агент — свій підплан.` : "Спершу обери lead-агента в картці агента праворуч."}</span></div></div>`}
      ${(phase === "planning" || phase === "plan_review") && html`<${PlanFlow} id=${id} m=${m} tick=${tick} where="overview" />`}
      ${pendingChanges.length > 0 && html`<div class="callout warn"><h3>Зміни плану чекають рішення (${pendingChanges.length})</h3><${Link} href=${`/r/${id}/ledger`}>Переглянути →</${Link}></div>`}
      ${(phase === "executing" || phase === "done") && html`<${Progress} tasks=${all} milestones=${m.milestones} />`}
      ${pendingAcks.length > 0 && html`<div class="card"><h3>Ще не підтвердили</h3>
        ${pendingAcks.map((l) => html`<div class="row small" style="padding:4px 0"><span class=${`badge ${l.kind}`}>${KINDS[l.kind]}</span><span>${l.title}</span><span class="spacer"></span><span class="muted">чекає: ${l.pendingAck.join(", ")}</span></div>`)}</div>`}
      <${RecentActivity} id=${id} tick=${tick} />
    </div>
    <div>
      <div class="row" style="margin-bottom:10px"><b>Агенти</b><span class="spacer"></span><button class="sm" onClick=${() => setCreating(true)}>+ Мій агент</button></div>
      ${m.agents.map((a) => {
        const working = all.filter((t) => t.owner === a.name && t.status === "in_progress");
        return html`<div class="agent-card">
          <div class="row"><span class=${`dot ${activity(a.last_seen)}`} title=${ago(a.last_seen)}></span><span class="nm">${a.name}</span>
            <span class=${`badge ${a.agent_type}`}>${AGENT_TYPES[a.agent_type]}</span>${a.id === m.room.lead_agent_id && html`<span class="badge lead">lead</span>`}
            ${a.paused && html`<span class="badge blocked">пауза</span>`}<span class="spacer"></span>
            ${(a.mine || m.me.role === "owner") && html`<button class="ghost sm" title="Змінити роль і зону" onClick=${() => setEditing(a)}>✎</button>`}
            ${a.mine && html`<button class="ghost sm" title="Команди підключення" onClick=${() => setSetup({ agent: a })}>⚙</button>`}</div>
          <div class="muted small" style="margin-top:4px">${a.role_title || "—"} · веде ${a.owner}${a.paths.length ? html` · <code>${a.paths.join(", ")}</code>` : ""}</div>
          ${a.status_text && html`<div class="status">${a.status_text}</div>`}
          ${working.map((t) => html`<div class="small" style="margin-top:4px">▸ <${Link} href=${`/r/${id}/tasks?t=${t.number}`}>#${t.number} ${t.title}</${Link}></div>`)}
          <div class="row small" style="margin-top:8px"><span class="dim">Активність: ${ago(a.last_seen)}</span><span class="spacer"></span>
            ${a.id !== m.room.lead_agent_id && phase === "setup" && html`<button class="ghost sm" onClick=${() => setLead(a.id)}>Зробити lead</button>`}
            ${(a.mine || m.me.role === "owner") && html`<button class="ghost sm" onClick=${tryToast(() => api(`/api/rooms/${id}/agents/${a.id}`, { method: "PATCH", body: { paused: !a.paused } }))}>${a.paused ? "▶ Продовжити" : "⏸ Пауза"}</button>`}</div>
        </div>`;
      })}
      ${!m.agents.length && html`<div class="empty">Підключи свого агента — Claude Code, Cursor або Codex.</div>`}
    </div>
    ${creating && html`<${CreateAgent} roomId=${id} repos=${m.repos} me=${m.me} onClose=${() => setCreating(false)} onCreated=${(r) => { setCreating(false); setSetup({ agent: r.agent, token: r.token }); refresh(); }} />`}
    ${setup && html`<${AgentSetup} roomId=${id} agent=${setup.agent} token=${setup.token} hubUrl=${m.hubUrl} onClose=${() => setSetup(null)} />`}
    ${editing && html`<${AgentEdit} roomId=${id} agent=${editing} repos=${m.repos} onClose=${() => setEditing(null)} />`}
  </div>`;
}

function Progress({ tasks, milestones }) {
  const done = tasks.filter((t) => t.status === "done").length;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return html`<div class="card"><h3>Прогрес · ${done}/${tasks.length} задач</h3>
    <div class="progress" style="margin-bottom:14px"><i style=${`width:${pct(done, tasks.length)}%`}></i></div>
    ${milestones.map((ms) => {
      const ts = tasks.filter((t) => t.milestone?.key === ms.key);
      const d = ts.filter((t) => t.status === "done").length;
      return html`<div class="ms-row"><div class="row"><b>${ms.title}</b><span class="dim small">${ms.key}</span><span class="spacer"></span><span class="muted">${d}/${ts.length}</span></div>
        <div class="progress"><i style=${`width:${pct(d, ts.length)}%`}></i></div></div>`;
    })}</div>`;
}

function RecentActivity({ id, tick }) {
  const a = useData(`/api/rooms/${id}/activity`, [tick]);
  return html`<div class="card"><h3>Остання активність</h3>
    ${(a.data || []).slice(0, 12).map((x) => html`<div class="act"><span class="time">${ago(x.created_at)}</span><span>${x.summary}</span></div>`)}
    <div style="margin-top:8px"><${Link} href=${`/r/${id}/activity`}>Уся активність →</${Link}></div></div>`;
}

// ====================== PLAN ======================
// ====================== PLAN FLOW: whose turn it is and how to move it ======================
// Prompts a human pastes into an agent's session (or that «Нагадати» posts in chat as an @mention).
const FLOW_PROMPTS = {
  lead: "Ти lead кімнати. Виклич get_context і одразу склади загальний план через propose_plan. Не чекай відповідей на питання: неясне запиши як припущення в overview, а питання постав у general паралельно.",
  subplan: "Виклич get_context і get_plan, потім напиши свій підплан через propose_subplan. Неясне запиши як припущення в summary, не чекай відповідей.",
  submit: "Усі підплани на місці. Виклич get_plan, перевір узгодженість залежностей і виклич submit_plan_for_review.",
  revise: "Люди попросили змін у плані. Виклич get_context і get_plan, онови план (propose_plan) або свій підплан (propose_subplan); lead потім знову викликає submit_plan_for_review.",
};

function planFlowState(m, plan) {
  const phase = m.room.phase;
  const lead = m.agents.find((a) => a.id === m.room.lead_agent_id);
  // The latest plan counts only if it belongs to this planning cycle (not the previously approved one).
  const draft = plan?.id && !["approved", "superseded"].includes(plan.status) ? plan : null;
  const ws = draft?.workstreams || [];
  const missing = ws.filter((w) => !draft.subplans.some((s) => s.agent.toLowerCase() === w.agent.toLowerCase())).map((w) => w.agent);
  const byName = (n) => m.agents.find((a) => a.name.toLowerCase() === n.toLowerCase());
  const submitted = phase !== "planning";
  const approved = phase === "executing" || phase === "done";
  const steps = [
    { key: "lead", title: "Lead складає загальний план", done: !!draft || submitted, who: lead ? [lead] : [],
      detail: draft ? `v${draft.version} від ${draft.created_by}` : lead ? `чекаємо ${lead.name}` : "lead-агента не обрано" },
    { key: "subplan", title: "Кожен агент пише свій підплан", done: (!!draft && !missing.length) || submitted, who: missing.map(byName).filter(Boolean),
      detail: !draft ? "після загального плану" : missing.length ? `чекаємо: ${missing.join(", ")}` : `усі ${ws.length} на місці` },
    { key: "submit", title: "Lead перевіряє узгодженість і відправляє на погодження", done: submitted, who: lead ? [lead] : [], detail: submitted ? "відправлено" : "" },
    { key: "approve", title: "Ви погоджуєте план", done: approved, who: [], detail: approved ? "погоджено" : phase === "plan_review" ? "ваша черга" : "" },
  ];
  return { steps, current: steps.findIndex((s) => !s.done), draft, revise: !!draft?.decision_note && phase === "planning" };
}

function PlanFlow({ id, m, tick, where }) {
  const plan = useData(`/api/rooms/${id}/plan`, [tick]);
  const general = useData(`/api/rooms/${id}/messages?channel=general`, [tick]);
  const { steps, current, draft, revise } = planFlowState(m, plan.data);
  const step = steps[current];
  if (!step) return null;
  const prompt = revise ? FLOW_PROMPTS.revise : FLOW_PROMPTS[step.key];
  // An agent's question in general that no human has answered yet.
  const msgs = general.data || [];
  let lastHuman = -1; msgs.forEach((x, i) => { if (x.author_kind === "human") lastHuman = i; });
  const question = msgs.slice(lastHuman + 1).reverse().find((x) => x.author_kind === "agent" && x.body.includes("?"));
  const nudge = tryToast(async (a) => {
    await api(`/api/rooms/${id}/messages`, { method: "POST", body: { channel: "general", body: `@${a.name} ${prompt}` } });
    toast(a.auto ? `${a.name} отримав нагадування — runner його розбудить` : `Нагадування в чаті. ${a.name} побачить його, коли ${a.mine ? "ти напишеш" : a.owner + " напише"} йому`);
  });
  // Rebuild the card (not patch its text) whenever the state changes: browser page translation swaps text
  // nodes, so in-place text updates would stay invisible on a translated page.
  const sig = [current, revise, step.detail, ...step.who.map((a) => `${a.name}:${a.auto}:${a.paused}:${ago(a.last_seen)}`), question?.id].join("|");
  return html`<div class="card flow" key=${sig}>
    <div class="row"><h3 style="margin:0">Хід планування</h3><span class="spacer"></span>
      ${where === "overview" && html`<${Link} href=${`/r/${id}/plan`} class="small">Відкрити план →</${Link}>`}</div>
    ${revise && html`<div class="callout warn" style="margin:12px 0 4px">Ви попросили змін: «${draft.decision_note}». Агенти оновлюють план, потім lead знову відправить його вам.</div>`}
    <div style="margin-top:8px">${steps.map((s, i) => html`<div class=${`check ${s.done ? "yes" : ""} ${i === current ? "now" : ""}`}>
      <span class="ic">${s.done ? "✓" : i + 1}</span><span>${s.title}</span>${s.detail && html`<span class="muted small">· ${s.detail}</span>`}</div>`)}</div>
    ${step.key === "approve" ? html`<div class="callout warn" style="margin:12px 0 0">Агенти зробили свою частину. ${where === "plan"
        ? "Перегляньте план нижче й натисніть «Погодити» або «Попросити змін»."
        : html`<${Link} href=${`/r/${id}/plan`}>Перегляньте й погодьте план →</${Link}>`}</div>`
      : html`<div class="flow-now"><div class="small muted" style="margin-bottom:6px">Зараз черга: ${step.who.length ? step.who.map((a) => a.name).join(", ") : "—"}</div>
        ${!step.who.length && html`<div class="muted small">Lead-агента немає. Обери його в <${Link} href=${`/r/${id}/settings`}>Налаштуваннях</${Link}>.</div>`}
        ${step.who.map((a) => html`<div class="flow-agent">
          <div class="row wrap"><span class=${`dot ${activity(a.last_seen)}`} title=${ago(a.last_seen)}></span><b>${a.name}</b>
            ${a.paused ? html`<span class="badge blocked">пауза</span>` : a.auto ? html`<span class="badge done">авто-режим</span>` : html`<span class="badge">ручний режим</span>`}
            <span class="muted small">веде ${a.owner} · активність: ${ago(a.last_seen)}</span><span class="spacer"></span>
            <button class="sm" onClick=${() => nudge(a)}>Нагадати в чаті</button></div>
          ${a.paused ? html`<p class="small muted">Агент на паузі й нічого не робить. Зніми паузу в його картці на вкладці Огляд.</p>`
            : a.auto ? html`<p class="small muted">Runner запущений: агент сам отримує сигнали й працює. Якщо довго тиша — натисни «Нагадати в чаті».</p>`
            : html`<p class="small muted">Без авто-режиму агент діє, лише коли ${a.mine ? "ти пишеш" : `${a.owner} пише`} йому в сесії${a.agent_type === "claude" ? " (або слеш-команда /mcp__room__plan)" : ""}. Надішли туди:</p>
              <${Code} text=${prompt} />
              <p class="small dim">Щоб агент реагував сам, запусти авто-режим: ⚙ у картці агента → вкладка «Авто-режим».</p>`}
        </div>`)}</div>`}
    ${question && html`<div class="flow-q small"><b>${question.author}</b> питав у чаті о ${time(question.created_at)}, відповіді ще немає.
      <${Link} href=${`/r/${id}/chat`}>Відповісти →</${Link}> <span class="muted">Агенти не мають чекати, але відповідь зробить план точнішим.</span></div>`}
  </div>`;
}

function Plan({ id, m, tick }) {
  const [vid, setVid] = useState(null);
  const plan = useData(`/api/rooms/${id}/plan${vid ? `?id=${vid}` : ""}`, [tick, vid]);
  const [comment, setComment] = useState("");
  const [note, setNote] = useState("");
  const p = plan.data?.id ? plan.data : null; // no plan yet → the API answers { ok: true }
  const flow = ["planning", "plan_review"].includes(m.room.phase) && html`<${PlanFlow} id=${id} m=${m} tick=${tick} where="plan" />`;
  if (!p) return html`<div style="max-width:1000px">${flow || html`<div class="empty">${m.room.phase === "setup" ? "План з'явиться після старту планування (вкладка Огляд → «Почати планування»)." : "Плану ще немає."}</div>`}</div>`;
  const decide = tryToast(async (approve) => {
    if (!approve && !note.trim()) return toast("Напиши, що змінити");
    await api(`/api/rooms/${id}/plan/decision`, { method: "POST", body: { approve, note } });
    setNote(""); toast(approve ? "План погоджено — агенти починають роботу" : "Агентам відправлено зауваження");
  });
  const addComment = tryToast(async () => { if (!comment.trim()) return; await api(`/api/rooms/${id}/plan/comments`, { method: "POST", body: { body: comment } }); setComment(""); });
  return html`<div style="max-width:1000px">
    ${flow}
    <div class="page-h"><h2>План v${p.version}</h2><span class=${`badge ${p.status}`}>${p.status}</span><span class="muted small">${p.created_by} · ${ago(p.created_at)}</span><span class="spacer"></span>
      <select style="width:auto" value=${vid || p.id} onChange=${(e) => setVid(Number(e.target.value))}>${p.versions.map((v) => html`<option value=${v.id}>v${v.version} · ${v.status}</option>`)}</select></div>
    ${m.room.phase === "plan_review" && p.status === "in_review" && html`<div class="callout warn"><h3>Погодьте план або попросіть змін</h3>
      <p class="muted small" style="margin:0 0 8px">Після погодження задачі створяться автоматично із залежностями, і агенти почнуть роботу.</p>
      <textarea rows="2" placeholder="Що змінити (обов'язково для «Попросити змін»)" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea>
      <div class="row" style="margin-top:8px"><button class="primary" onClick=${() => decide(true)}>✓ Погодити план</button><button onClick=${() => decide(false)}>Попросити змін</button></div></div>`}
    <div class="card"><h3>Ціль</h3><div>${p.goal}</div>${p.overview && html`<div style="margin-top:10px"><${Markdown} text=${p.overview} /></div>`}
      <div class="row wrap" style="margin-top:12px">${p.milestones.map((ms, i) => html`<span class="badge">${i + 1}. ${ms.title} <span class="dim">${ms.key}</span></span>`)}</div></div>
    <h3 style="margin:22px 0 10px">Робочі потоки й підплани</h3>
    ${p.workstreams.map((w) => {
      const sp = p.subplans.find((s) => s.agent.toLowerCase() === w.agent.toLowerCase());
      return html`<div class="ws"><div class="ws-h"><b>${w.agent}</b><span class="muted small">${w.summary}</span><span class="spacer"></span>
        ${sp ? html`<span class="badge done">${sp.tasks.length} задач</span>` : html`<span class="badge pending">підплан очікується</span>`}</div>
        ${sp?.summary && html`<div class="ptask muted small">${sp.summary}</div>`}
        ${(sp?.tasks || []).map((t) => html`<div class="ptask"><div class="row wrap"><span class="k">${t.key}</span><b>${t.title}</b><span class="badge">${t.milestone}</span>
          ${t.depends_on.length > 0 && html`<span class="muted small">після ${t.depends_on.join(", ")}</span>`}</div>
          ${t.description && html`<div class="muted small" style="margin-top:4px;white-space:pre-wrap">${t.description}</div>`}
          ${t.acceptance && html`<div class="small" style="margin-top:4px">✔ ${t.acceptance}</div>`}
          ${t.paths.length > 0 && html`<div class="small dim" style="margin-top:2px">${t.paths.join(", ")}</div>`}
          ${t.subtasks.length > 0 && html`<ul>${t.subtasks.map((s) => html`<li>${s}</li>`)}</ul>`}</div>`)}</div>`;
    })}
    <div class="card"><h3>Коментарі до плану</h3>
      ${p.comments.map((c) => html`<div class="comment"><b>${c.author}</b> <span class="dim small">${ago(c.created_at)}</span><div>${c.body}</div></div>`)}
      ${!p.comments.length && html`<div class="muted small">Поки немає.</div>`}
      <div class="row" style="margin-top:10px"><input placeholder="Коментар для агентів (lead отримає сповіщення)" value=${comment} onInput=${(e) => setComment(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && addComment()} /><button onClick=${addComment}>Надіслати</button></div></div>
  </div>`;
}

// ====================== TASKS ======================
function Tasks({ id, m, tick }) {
  const tasks = useData(`/api/rooms/${id}/tasks`, [tick]);
  const [filter, setFilter] = useState("");
  const qs = new URLSearchParams(location.search);
  const [open, setOpen] = useState(qs.get("t") ? Number(qs.get("t")) : null);
  const [creating, setCreating] = useState(false);
  const all = (tasks.data || []).filter((t) => !filter || t.owner === filter);
  const cols = ["todo", "in_progress", "blocked", "review", "done"];
  const current = open && (tasks.data || []).find((t) => t.number === open);
  return html`<div>
    <div class="page-h"><h2>Задачі</h2>
      <select style="width:auto" value=${filter} onChange=${(e) => setFilter(e.target.value)}><option value="">Усі агенти</option>${m.agents.map((a) => html`<option value=${a.name}>${a.name}</option>`)}</select>
      <span class="spacer"></span><button class="primary" onClick=${() => setCreating(true)}>+ Задача</button></div>
    ${!(tasks.data || []).length && html`<div class="empty">Задачі створюються автоматично, коли ви погоджуєте план. Можна додати і вручну.</div>`}
    ${(tasks.data || []).length > 0 && html`<div class="board">${cols.map((c) => {
      const ts = all.filter((t) => (c === "blocked" ? t.status === "blocked" || (t.status === "todo" && t.blocked_by.length) : c === "todo" ? t.status === "todo" && !t.blocked_by.length : t.status === c));
      return html`<div class="bcol"><div class="bcol-h"><span class=${`badge ${c}`}>${STATUS[c]}</span><span>${ts.length}</span></div>
        ${ts.map((t) => {
          const sd = t.subtasks.filter((s) => s.done).length;
          return html`<div class="tcard" onClick=${() => setOpen(t.number)}><div class="t"><span class="dim">#${t.number}</span> ${t.title}</div>
            <div class="meta">${t.owner ? html`<span>@${t.owner}</span>` : html`<span class="dim">не призначено</span>`}${t.milestone && html`<span>${t.milestone.key}</span>`}
              ${t.blocked_by.length > 0 && html`<span style="color:var(--red)">⛔ ${t.blocked_by.map((n) => "#" + n).join(",")}</span>`}
              ${t.pr && html`<span>PR #${t.pr.number}${t.pr.ci_state === "failing" ? " ✗" : t.pr.ci_state === "passing" ? " ✓" : ""}</span>`}</div>
            ${t.subtasks.length > 0 && html`<div class="subbar"><i style=${`width:${Math.round((sd / t.subtasks.length) * 100)}%`}></i></div>`}</div>`;
        })}</div>`;
    })}</div>`}
    ${current && html`<${TaskModal} id=${id} m=${m} t=${current} all=${tasks.data} onClose=${() => setOpen(null)} />`}
    ${creating && html`<${TaskCreate} id=${id} m=${m} onClose=${() => setCreating(false)} />`}
  </div>`;
}

function TaskModal({ id, m, t, all, onClose }) {
  const [note, setNote] = useState("");
  const [sub, setSub] = useState("");
  const patch = tryToast(async (body) => api(`/api/rooms/${id}/tasks/${t.number}`, { method: "PATCH", body }));
  const msgs = useData(`/api/rooms/${id}/messages?channel=task:${t.number}`, [t.updated_at]);
  return html`<${Modal} onClose=${onClose}>
    <div class="row"><h2 style="margin:0"><span class="dim">#${t.number}</span> ${t.title}</h2></div>
    <div class="row wrap small" style="margin:8px 0 12px">
      <select style="width:auto" value=${t.status} onChange=${(e) => patch({ status: e.target.value })}>${Object.entries(STATUS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select>
      <select style="width:auto" value=${t.owner || ""} onChange=${(e) => patch({ owner: e.target.value })}><option value="">— не призначено —</option>${m.agents.map((a) => html`<option value=${a.name}>${a.name}</option>`)}</select>
      ${t.milestone && html`<span class="badge">${t.milestone.title}</span>`}${t.plan_key && html`<code>${t.plan_key}</code>`}
      ${t.pr && html`<a href=${t.pr.url} target="_blank" rel="noopener">PR #${t.pr.number} · ${t.pr.state}${t.pr.ci_state ? ` · CI ${t.pr.ci_state}` : ""}</a>`}
    </div>
    ${t.description && html`<div style="white-space:pre-wrap">${t.description}</div>`}
    ${t.acceptance && html`<div class="card" style="margin-top:10px;padding:10px 12px"><b class="small">Критерії готовності</b><div style="white-space:pre-wrap">${t.acceptance}</div></div>`}
    ${t.deps.length > 0 && html`<p class="small">Залежить від: ${t.deps.map((d) => html`<span class=${`badge ${d.status}`} style="margin-right:4px">#${d.number} ${d.title}</span>`)}</p>`}
    ${t.paths.length > 0 && html`<p class="small muted">Файли: <code>${t.paths.join(", ")}</code></p>`}
    <label class="f">Підзадачі (план агента)</label>
    ${t.subtasks.map((s) => html`<label class=${`subtask ${s.done ? "done" : ""}`}><input type="checkbox" checked=${!!s.done} onChange=${tryToast(() => api(`/api/rooms/${id}/subtasks/${s.id}`, { method: "PATCH", body: { done: !s.done } }))} /><span>${s.title}</span></label>`)}
    <div class="row" style="margin-top:6px"><input placeholder="Додати підзадачу" value=${sub} onInput=${(e) => setSub(e.target.value)} onKeyDown=${async (e) => { if (e.key === "Enter" && sub.trim()) { await api(`/api/rooms/${id}/tasks/${t.number}/subtasks`, { method: "POST", body: { subtasks: [sub] } }); setSub(""); } }} /></div>
    <label class="f">Нотатки</label>
    ${t.notes.map((n) => html`<div class="note"><b>${n.author}</b> <span class="dim small">${ago(n.created_at)}</span><div>${n.body}</div></div>`)}
    <div class="row"><input placeholder="Нотатка для агента (агент отримає сповіщення)" value=${note} onInput=${(e) => setNote(e.target.value)} onKeyDown=${async (e) => { if (e.key === "Enter" && note.trim()) { await patch({ note }); setNote(""); } }} /></div>
    ${(msgs.data || []).length > 0 && html`<label class="f">Обговорення задачі (task:${t.number})</label>${msgs.data.slice(-6).map((x) => html`<div class="note"><b>${x.author}</b> <span class="dim small">${time(x.created_at)}</span><div>${x.body}</div></div>`)}
      <${Link} href=${`/r/${id}/chat?c=task:${t.number}`} class="small">Відкрити в чаті →</${Link}>`}
    <div class="actions"><button class="ghost danger" style="margin-right:auto" onClick=${tryToast(async () => { if (confirm("Видалити задачу?")) { await api(`/api/rooms/${id}/tasks/${t.number}`, { method: "DELETE" }); onClose(); } })}>Видалити</button><button onClick=${onClose}>Закрити</button></div>
  </${Modal}>`;
}

function TaskCreate({ id, m, onClose }) {
  const [f, setF] = useState({ title: "", description: "", acceptance: "", owner: "", depends_on: "", paths: "", milestone: "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const go = tryToast(async () => {
    await api(`/api/rooms/${id}/tasks`, { method: "POST", body: { ...f, owner: f.owner || null, depends_on: f.depends_on.split(/[,\s]+/).filter(Boolean), paths: f.paths.split(",").map((s) => s.trim()).filter(Boolean) } });
    onClose();
  });
  return html`<${Modal} onClose=${onClose}><h2>Нова задача</h2>
    <label class="f">Назва</label><input value=${f.title} onInput=${set("title")} />
    <label class="f">Опис</label><textarea rows="4" value=${f.description} onInput=${set("description")}></textarea>
    <label class="f">Критерії готовності</label><input value=${f.acceptance} onInput=${set("acceptance")} />
    <div class="grid2">
      <div><label class="f">Агент</label><select value=${f.owner} onChange=${set("owner")}><option value="">—</option>${m.agents.map((a) => html`<option value=${a.name}>${a.name}</option>`)}</select></div>
      <div><label class="f">Етап</label><select value=${f.milestone} onChange=${set("milestone")}><option value="">—</option>${m.milestones.map((ms) => html`<option value=${ms.key}>${ms.title}</option>`)}</select></div>
      <div><label class="f">Залежить від (номери)</label><input value=${f.depends_on} placeholder="3, 5" onInput=${set("depends_on")} /></div>
      <div><label class="f">Файли</label><input value=${f.paths} placeholder="frontend/src/x/**" onInput=${set("paths")} /></div>
    </div>
    <div class="actions"><button onClick=${onClose}>Скасувати</button><button class="primary" onClick=${go}>Створити</button></div></${Modal}>`;
}

// ====================== LEDGER (general context) ======================
function Ledger({ id, m, ledger }) {
  const [f, setF] = useState({ kind: "decision", title: "", body: "", affects: [] });
  const [show, setShow] = useState(false);
  const [kind, setKind] = useState("");
  const publish = tryToast(async () => {
    await api(`/api/rooms/${id}/ledger`, { method: "POST", body: { ...f, affects: f.affects.length ? f.affects : ["all"] } });
    setF({ kind: "decision", title: "", body: "", affects: [] }); setShow(false);
  });
  const decide = tryToast(async (lid, approve) => { const r = await api(`/api/rooms/${id}/ledger/${lid}/decision`, { method: "POST", body: { approve } }); toast(approve ? `Погоджено${r.created.length ? `, задачі ${r.created.map((n) => "#" + n).join(", ")}` : ""}` : "Відхилено"); });
  const items = ledger.filter((l) => !kind || l.kind === kind);
  return html`<div style="max-width:960px">
    <div class="page-h"><h2>Загальний контекст</h2><span class="spacer"></span>
      <select style="width:auto" value=${kind} onChange=${(e) => setKind(e.target.value)}><option value="">Усі типи</option>${Object.entries(KINDS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select>
      <button class="primary" onClick=${() => setShow(!show)}>+ Запис</button></div>
    <p class="muted small" style="margin-top:-8px">Лише важливе, що мають знати всі агенти: рішення, зміни API, env, блокери, передачі. Кожен зачеплений агент мусить підтвердити (ack) запис — тут видно, хто ще ні.</p>
    ${show && html`<div class="card"><div class="grid2">
        <div><label class="f">Тип</label><select value=${f.kind} onChange=${(e) => setF({ ...f, kind: e.target.value })}>${Object.entries(KINDS).filter(([k]) => k !== "plan_change").map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div>
        <div><label class="f">Для кого</label><select multiple size="3" onChange=${(e) => setF({ ...f, affects: [...e.target.selectedOptions].map((o) => o.value) })}>${m.agents.map((a) => html`<option value=${a.name}>${a.name}</option>`)}</select><div class="dim small">нічого не обрано = усі</div></div></div>
      <label class="f">Заголовок</label><input value=${f.title} onInput=${(e) => setF({ ...f, title: e.target.value })} />
      <label class="f">Деталі</label><textarea rows="4" value=${f.body} onInput=${(e) => setF({ ...f, body: e.target.value })}></textarea>
      <div class="actions"><button onClick=${() => setShow(false)}>Скасувати</button><button class="primary" onClick=${publish}>Опублікувати</button></div></div>`}
    ${items.map((l) => html`<div class=${`lentry ${l.status === "resolved" ? "resolved" : ""}`}>
      <div class="row wrap"><span class=${`badge ${l.kind}`}>${KINDS[l.kind] || l.kind}</span><b>${l.title}</b>
        ${l.kind === "plan_change" && html`<span class=${`badge ${l.status}`}>${l.status}</span>`}${l.status === "resolved" && html`<span class="badge">вирішено</span>`}</div>
      ${l.body && html`<div class="lbody">${l.body}</div>`}
      ${l.kind === "plan_change" && l.payload?.tasks?.length > 0 && html`<ul class="small">${l.payload.tasks.map((t) => html`<li><code>${t.key}</code> ${t.title} → ${t.owner}${t.depends_on.length ? ` (після ${t.depends_on.join(", ")})` : ""}</li>`)}</ul>`}
      <div class="foot"><span>${l.author} · ${ago(l.created_at)}</span><span>для: ${l.affects.includes("all") ? "усіх" : l.affects.join(", ")}</span>
        ${l.ackedBy.length > 0 && html`<span style="color:var(--green)">✓ ${l.ackedBy.join(", ")}</span>`}
        ${l.pendingAck.length > 0 && l.status !== "resolved" && html`<span style="color:var(--amber)">⏳ ${l.pendingAck.join(", ")}</span>`}
        <span class="spacer"></span>
        ${l.kind === "plan_change" && l.status === "pending" && html`<button class="primary sm" onClick=${() => decide(l.id, true)}>Погодити</button><button class="sm" onClick=${() => decide(l.id, false)}>Відхилити</button>`}
        ${l.kind !== "plan_change" && html`<button class="ghost sm" onClick=${tryToast(() => api(`/api/rooms/${id}/ledger/${l.id}`, { method: "PATCH", body: { status: l.status === "resolved" ? "active" : "resolved" } }))}>${l.status === "resolved" ? "Повернути" : "Вирішено"}</button>`}
      </div></div>`)}
    ${!items.length && html`<div class="empty">Поки порожньо. Агенти публікують сюди тільки важливе.</div>`}
  </div>`;
}

// ====================== CHAT ======================
function Chat({ id, m, tick, user }) {
  const [ch, setCh] = useState(new URLSearchParams(location.search).get("c") || "general");
  const chans = useData(`/api/rooms/${id}/channels`, [tick]);
  const msgs = useData(`/api/rooms/${id}/messages?channel=${encodeURIComponent(ch)}`, [tick, ch]);
  const [text, setText] = useState("");
  const [dm, setDm] = useState("");
  const feed = useRef();
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [msgs.data]);
  const agentNames = new Set(m.agents.map((a) => a.name));
  const list = chans.data || [];
  const label = ch === "general" ? "# general" : list.find((c) => c.channel === ch)?.label || ch;
  const send = tryToast(async () => {
    if (!text.trim()) return;
    if (ch.startsWith("new:")) { const r = await api(`/api/rooms/${id}/messages`, { method: "POST", body: { to: ch.slice(4), body: text } }); setCh(r.channel); }
    else await api(`/api/rooms/${id}/messages`, { method: "POST", body: { channel: ch, body: text } });
    setText("");
  });
  const startDm = (name) => {
    if (!name) return;
    const a = m.agents.find((x) => x.name === name);
    const mem = m.members.find((x) => x.username === name);
    const ref = a ? `agent:${a.id}` : mem ? `user:${mem.id}` : null;
    const key = ref && `dm:${[`user:${user.id}`, ref].sort().join(",")}`;
    setCh(list.some((c) => c.channel === key) ? key : `new:${name}`); setDm("");
  };
  const group = (pfx) => list.filter((c) => c.channel.startsWith(pfx));
  return html`<div class="chat">
    <div class="chans">
      <div class=${`chan ${ch === "general" ? "on" : ""}`} onClick=${() => setCh("general")}># general</div>
      <div class="sb-h">Особисті</div>
      ${group("dm:").map((c) => html`<div class=${`chan ${ch === c.channel ? "on" : ""}`} onClick=${() => setCh(c.channel)} title=${c.label}>${c.mine ? "● " : ""}${c.label.replace("dm with ", "")}</div>`)}
      <select value=${dm} onChange=${(e) => startDm(e.target.value)} style="margin-top:6px;font-size:12.5px"><option value="">+ Написати…</option>
        ${m.agents.map((a) => html`<option value=${a.name}>🤖 ${a.name}</option>`)}${m.members.filter((x) => x.id !== user.id).map((x) => html`<option value=${x.username}>👤 ${x.display_name}</option>`)}</select>
      <div class="sb-h">Задачі</div>
      ${group("task:").map((c) => html`<div class=${`chan ${ch === c.channel ? "on" : ""}`} onClick=${() => setCh(c.channel)}>${c.channel.replace("task:", "#")}</div>`)}
    </div>
    <div class="chat-main">
      <div class="chat-h">${ch.startsWith("new:") ? `→ ${ch.slice(4)}` : label}</div>
      <div class="feed" ref=${feed}>
        ${(msgs.data || []).map((x) => html`<div class=${`msg ${x.author_kind} ${agentNames.has(x.author) ? "agent" : ""}`}>
          <div class="meta"><span class="from">${x.author}</span><span>${time(x.created_at)}</span></div><div class="text"><${Markdown} text=${x.body} /></div></div>`)}
        ${!(msgs.data || []).length && html`<div class="muted">Порожньо. ${ch === "general" ? "Тут агенти координуються. Пиши @ім'я, щоб покликати агента." : ""}</div>`}
      </div>
      <div class="composer"><textarea rows="1" placeholder=${ch === "general" ? "Повідомлення всім (@claude-fe — щоб покликати агента)" : "Повідомлення…"} value=${text}
        onInput=${(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(200, e.target.scrollHeight) + "px"; }}
        onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea><button class="primary" onClick=${send}>➤</button></div>
    </div>
  </div>`;
}

// ====================== ACTIVITY & PRs ======================
function Activity({ id, tick }) {
  const a = useData(`/api/rooms/${id}/activity`, [tick]);
  return html`<div style="max-width:900px"><div class="page-h"><h2>Активність</h2></div>
    ${(a.data || []).map((x) => html`<div class="act"><span class="time">${new Date(x.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><span>${x.summary}</span></div>`)}</div>`;
}

function PRs({ id, m, tick }) {
  const prs = useData(`/api/rooms/${id}/prs`, [tick]);
  return html`<div style="max-width:1000px"><div class="page-h"><h2>Pull requests</h2></div>
    ${!m.repos.length && html`<div class="callout">Підключи репозиторій у <${Link} href=${`/r/${id}/settings`}>Налаштуваннях</${Link}> — тоді PR автоматично прив'язуються до задач, а агенти отримують рев'ю й результати CI.</div>`}
    ${(prs.data || []).map((p) => html`<div class="lentry"><div class="row wrap"><span class=${`badge ${p.state}`}>${p.state}</span><a href=${p.url} target="_blank" rel="noopener"><b>#${p.number} ${p.title}</b></a>
        ${p.ci_state && html`<span class=${`badge ${p.ci_state}`}>CI ${p.ci_state}</span>`}<span class="spacer"></span><span class="muted small">${p.repo} · ${p.branch}</span></div>
      <div class="foot">${p.task_number ? html`<${Link} href=${`/r/${id}/tasks?t=${p.task_number}`}>задача #${p.task_number} ${p.task_title}</${Link}>` : html`<span style="color:var(--amber)">не прив'язано до задачі</span>`}<span>${p.author || ""}</span><span>${ago(p.updated_at)}</span></div>
      ${p.feedback.length > 0 && html`<div style="margin-top:8px">${p.feedback.slice(0, 4).map((f) => html`<div class="note"><span class="badge">${f.kind}</span> <b>${f.author}</b>${f.path ? html` <code>${f.path}</code>` : ""}<div>${f.body}</div></div>`)}</div>`}</div>`)}
    ${m.repos.length > 0 && !(prs.data || []).length && html`<div class="empty">PR ще немає. Агенти відкривають їх з гілок <code>${"room/<номер>-slug"}</code>.</div>`}</div>`;
}

// ====================== SETTINGS ======================
function Settings({ id, m, refresh }) {
  const owner = m.me.role === "owner";
  const [invite, setInvite] = useState(null);
  const [repo, setRepo] = useState({ fullName: "", apiToken: "" });
  const [newRepo, setNewRepo] = useState(null);
  const [setup, setSetup] = useState(null);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const mkInvite = tryToast(async () => setInvite(await api(`/api/rooms/${id}/invites`, { method: "POST", body: { hours: 24 } })));
  const addRepo = tryToast(async () => { setNewRepo(await api(`/api/rooms/${id}/repos`, { method: "POST", body: repo })); setRepo({ fullName: "", apiToken: "" }); });
  return html`<div style="max-width:960px">
    <div class="card"><h3>Учасники</h3>
      <table class="t"><tbody>${m.members.map((u) => html`<tr><td>${u.display_name} <span class="dim">@${u.username}</span></td><td>${u.role === "owner" ? html`<span class="badge owner">власник</span>` : "учасник"}</td>
        <td class="muted small">${ago(u.joined_at)}</td><td style="text-align:right">${owner && u.role !== "owner" && html`<button class="ghost sm danger" onClick=${tryToast(async () => { if (confirm(`Видалити ${u.display_name} і його агентів?`)) await api(`/api/rooms/${id}/members/${u.id}`, { method: "DELETE" }); })}>Видалити</button>`}</td></tr>`)}</tbody></table>
      ${owner && html`<div style="margin-top:12px"><button onClick=${mkInvite}>Створити запрошення</button>
        ${invite && html`<div style="margin-top:10px"><p class="small muted">Одноразове посилання, діє ${invite.expiresInHours} год. Тіммейт входить (або реєструється) і потрапляє в кімнату.</p><${Code} text=${`${location.origin}/join/${invite.code}`} /></div>`}</div>`}
      ${!owner && html`<p class="muted small">Запрошувати може лише власник кімнати.</p>`}</div>

    <div class="card"><div class="row"><h3 style="margin:0">Агенти</h3><span class="spacer"></span><button class="sm" onClick=${() => setCreating(true)}>+ Мій агент</button></div>
      <table class="t" style="margin-top:8px"><thead><tr><th>Агент</th><th>Роль / зона</th><th>Власник</th><th></th></tr></thead><tbody>
      ${m.agents.map((a) => html`<tr><td><b>${a.name}</b> <span class=${`badge ${a.agent_type}`}>${AGENT_TYPES[a.agent_type]}</span>${a.id === m.room.lead_agent_id && html` <span class="badge lead">lead</span>`}</td>
        <td class="small">${a.role_title || "—"}<br /><code>${a.paths.join(", ") || "—"}</code></td><td class="small">${a.owner}</td>
        <td style="text-align:right">${(a.mine || owner) && html`<button class="ghost sm" onClick=${() => setEditing(a)}>Змінити</button><button class="ghost sm" onClick=${() => setSetup({ agent: a })}>Підключення</button>
          <button class="ghost sm danger" onClick=${tryToast(async () => { if (confirm(`Видалити агента ${a.name}?`)) await api(`/api/rooms/${id}/agents/${a.id}`, { method: "DELETE" }); })}>✕</button>`}</td></tr>`)}</tbody></table>
      <div class="row" style="margin-top:12px"><span class="small muted">Lead-агент (складає загальний план):</span>
        <select style="width:auto" value=${m.room.lead_agent_id || ""} onChange=${tryToast((e) => api(`/api/rooms/${id}/lead`, { method: "PUT", body: { agentId: e.target.value || null } }))}><option value="">—</option>${m.agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select></div></div>

    <div class="card"><h3>Репозиторії GitHub</h3>
      ${m.repos.map((r) => html`<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><b>${r.full_name}</b><span class="muted small">${r.default_branch}</span>
        ${r.has_token ? html`<span class="badge done">token</span>` : html`<span class="badge" title="Без токена не працює детектор конфліктів між PR">без токена</span>`}<span class="spacer"></span>
        ${owner && html`<button class="ghost sm" onClick=${() => setNewRepo({ ...r, secret: r.webhook_secret, webhookUrl: `${m.hubUrl}/api/github/webhook/${r.id}` })}>Webhook</button>
        <button class="ghost sm danger" onClick=${tryToast(async () => { if (confirm("Від'єднати репозиторій?")) await api(`/api/rooms/${id}/repos/${r.id}`, { method: "DELETE" }); })}>✕</button>`}</div>`)}
      ${owner ? html`<div class="grid2" style="margin-top:6px"><div><label class="f">Репозиторій</label><input placeholder="owner/name" value=${repo.fullName} onInput=${(e) => setRepo({ ...repo, fullName: e.target.value })} /></div>
        <div><label class="f">Token (необов'язково, read-only: Pull requests)</label><input type="password" placeholder="github_pat_…" value=${repo.apiToken} onInput=${(e) => setRepo({ ...repo, apiToken: e.target.value })} /></div></div>
        <div class="row" style="margin-top:10px"><button class="primary" onClick=${addRepo}>Підключити</button></div>` : html`<p class="muted small">Підключає репозиторії власник кімнати.</p>`}
      ${newRepo && html`<div style="margin-top:14px"><b>Налаштуй webhook у GitHub</b>
        <p class="small muted">GitHub → ${newRepo.fullName || newRepo.full_name} → Settings → Webhooks → Add webhook. Content type: <code>application/json</code>. Events: «Let me select» → Pull requests, Pull request reviews, Pull request review comments, Issue comments, Check suites, Check runs, Statuses.</p>
        <label class="f">Payload URL</label><${Code} text=${newRepo.webhookUrl} /><label class="f">Secret</label><${Code} text=${newRepo.secret} /></div>`}</div>

    ${owner && html`<div class="card"><h3>Кімната</h3><div class="row wrap">
      ${m.room.phase === "executing" && html`<button onClick=${tryToast(() => api(`/api/rooms/${id}/phase`, { method: "POST", body: { phase: "done" } }))}>Позначити проєкт завершеним</button>`}
      ${m.room.phase === "done" && html`<button onClick=${tryToast(() => api(`/api/rooms/${id}/phase`, { method: "POST", body: { phase: "executing" } }))}>Повернути у виконання</button>`}
      ${["executing", "done"].includes(m.room.phase) && html`<button onClick=${tryToast(() => api(`/api/rooms/${id}/phase/start-planning`, { method: "POST" }))}>Новий цикл планування</button>`}
      <span class="spacer"></span><button class="danger" onClick=${tryToast(async () => { if (prompt(`Щоб видалити кімнату назавжди, введи її назву: ${m.room.name}`) === m.room.name) { await api(`/api/rooms/${id}`, { method: "DELETE" }); navigate("/"); } })}>Видалити кімнату</button></div></div>`}
    ${creating && html`<${CreateAgent} roomId=${id} repos=${m.repos} me=${m.me} onClose=${() => setCreating(false)} onCreated=${(r) => { setCreating(false); setSetup({ agent: r.agent, token: r.token }); refresh(); }} />`}
    ${setup && html`<${AgentSetup} roomId=${id} agent=${setup.agent} token=${setup.token} hubUrl=${m.hubUrl} onClose=${() => setSetup(null)} />`}
    ${editing && html`<${AgentEdit} roomId=${id} agent=${editing} repos=${m.repos} onClose=${() => setEditing(null)} />`}
  </div>`;
}
