import { html, useState, api, toast, copy, Code, Modal, AGENT_TYPES } from "./lib.js";

// `text` with `inline code` → htm nodes
const rich = (s) => s.split("`").map((part, i) => (i % 2 ? html`<code>${part}</code>` : part));

// One step = { h: title, body: [{ p } | { code } | { note } | { warn }] }. The same data renders the
// modal and builds the «Скопіювати все» text, so the two never drift apart.
function stepsToText(title, steps) {
  const out = [`# ${title}`, "", "> Містить токен агента. Не коміть і не публікуй цей текст.", ""];
  for (const s of steps) {
    out.push(`## ${s.h}`);
    for (const b of s.body) {
      if (b.code !== undefined) out.push("```", b.code, "```");
      else out.push(b.p ?? b.note ?? b.warn);
    }
    out.push("");
  }
  return out.join("\n");
}

const Step = ({ s }) => html`<div class="step"><h4>${s.h}</h4>${s.body.map((b) =>
  b.code !== undefined ? html`<${Code} text=${b.code} />`
  : b.note ? html`<p class="dim small">${rich(b.note)}</p>`
  : b.warn ? html`<div class="secret">${rich(b.warn)}</div>`
  : html`<p>${rich(b.p)}</p>`)}</div>`;

// ---------- connect-agent instructions (token shown only here, only once) ----------
export function AgentSetup({ roomId, agent, token: initialToken, hubUrl, onClose }) {
  const [token, setToken] = useState(initialToken || null);
  const [tab, setTab] = useState(agent.agent_type in { claude: 1, cursor: 1, codex: 1 } ? agent.agent_type : "other");
  const [copiedAll, setCopiedAll] = useState(false);
  const reissue = async () => {
    if (!confirm("Створити новий токен? Старий одразу перестане працювати (агента треба буде перепідключити).")) return;
    try { setToken((await api(`/api/rooms/${roomId}/agents/${agent.id}/token`, { method: "POST" })).token); } catch (e) { toast(e.message); }
  };
  if (!token) {
    return html`<${Modal} onClose=${onClose}>
      <h2>Підключення: ${agent.name}</h2>
      <p class="muted">Токен агента показується лише один раз і зберігається в хабі тільки як хеш. Щоб отримати команди підключення знову, створи новий токен.</p>
      <div class="actions"><button onClick=${onClose}>Закрити</button><button class="primary" onClick=${reissue}>Створити новий токен</button></div>
    </${Modal}>`;
  }
  const mcp = `${hubUrl}/mcp/${token}`;
  const pointer = `${hubUrl}/api/agent/${token}/pointer`;
  const inbox = `${hubUrl}/api/agent/${token}/inbox`;
  const hook = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `curl -s ${inbox}` }] }] } }, null, 2);
  const kickoff = `Ти підключений до командної кімнати через MCP-сервер "room". Виклич get_context і дій за його розділом "Next action". Дотримуйся /team/workflow.md.`;
  const runner = `curl -fsSL ${hubUrl}/room-runner.mjs -o room-runner.mjs\nnode room-runner.mjs --hub ${hubUrl} --token ${token} --agent ${agent.agent_type === "other" ? "claude" : agent.agent_type}`;
  const tabs = {
    claude: [
      { h: "1. Підключи MCP-сервер кімнати", body: [{ p: "У терміналі VS Code, у папці репозиторію:" }, { code: `claude mcp add --transport http room ${mcp}` },
        { note: "Перевірка: `/mcp` всередині Claude Code — «room» має бути connected." }] },
      { h: "2. Короткий вказівник у CLAUDE.md", body: [{ p: "Усі інструкції живуть у кімнаті й завжди актуальні; у репо лише вказівник." }, { code: `curl -s ${pointer} >> CLAUDE.md` }] },
      { h: "3. Хук: нові повідомлення в кожному запиті (рекомендовано)", body: [{ p: "Додай у `.claude/settings.local.json` (не комітиться):" }, { code: hook }] },
      { h: "4. Субагенти команди", body: [{ p: "Попроси агента: «виклич get_subagent_templates і збережи файли в .claude/agents/»." }] },
      { h: "5. Старт", body: [{ p: "Слеш-команда `/mcp__room__start` або цей запит:" }, { code: kickoff }] },
    ],
    cursor: [
      { h: "1. Підключи MCP-сервер кімнати", body: [{ p: "`.cursor/mcp.json` у проєкті (додай у .gitignore — там токен) або глобально `~/.cursor/mcp.json`:" },
        { code: JSON.stringify({ mcpServers: { room: { url: mcp } } }, null, 2) }, { note: "Settings → MCP: «room» із зеленою точкою." }] },
      { h: "2. Правило-вказівник", body: [{ code: `mkdir -p .cursor/rules && curl -s "${pointer}?format=cursor" > .cursor/rules/room.mdc` }] },
      { h: "3. Старт (режим Agent)", body: [{ code: kickoff }] },
    ],
    codex: [
      { h: "1. Підключи MCP-сервер кімнати", body: [{ code: `codex mcp add room --url ${mcp}` }, { p: "або в `~/.codex/config.toml`:" }, { code: `[mcp_servers.room]\nurl = "${mcp}"` }] },
      { h: "2. Вказівник в AGENTS.md", body: [{ code: `curl -s ${pointer} >> AGENTS.md` }] },
      { h: "3. Старт", body: [{ code: kickoff }] },
    ],
    other: [
      { h: "MCP endpoint (Streamable HTTP)", body: [{ code: mcp }] },
      { h: "Вказівник", body: [{ code: `curl -s ${pointer} >> AGENTS.md` }] },
      { h: "Старт", body: [{ code: kickoff }] },
    ],
    runner: [
      { h: "Авто-режим: агент сам реагує на кімнату", body: [
        { p: "Runner будить агента тільки коли це його стосується: особисті повідомлення, його задачі, @згадки, записи ledger для нього, розблоковані задачі, фідбек з PR. Для Claude Code сесія продовжується окремо для кожної задачі (`--resume`), є ліміт запусків на годину й пауза з веб-інтерфейсу." },
        { code: runner },
        { warn: "У цьому режимі агент редагує файли без підтвердження. Працюй у гілці, додай `.room-runner.json` у .gitignore, переглядай PR перед мерджем." }] },
    ],
  };
  const tabLabel = (k) => (k === "runner" ? "Авто-режим" : AGENT_TYPES[k]);
  const copyAll = () => { copy(stepsToText(`Підключення агента ${agent.name} — ${tabLabel(tab)}`, tabs[tab])); setCopiedAll(true); };
  const done = () => {
    if (copiedAll || confirm("Закрити вікно? Токен більше не покажеться. Якщо ще не зберіг усі команди, натисни «Скасувати» й скористайся кнопкою «Скопіювати все».")) onClose();
  };
  return html`<${Modal} onClose=${done} persistent>
    <h2>Підключення: ${agent.name}</h2>
    <div class="secret">🔑 Токен показується <b>лише зараз</b>. Скопіюй команди й передай їх людині, яка запускає агента. Втратив — створи новий токен.</div>
    <div class="mtabs">${[...Object.keys(AGENT_TYPES), "runner"].map((k) => html`<button class=${tab === k ? "on" : ""} onClick=${() => setTab(k)}>${tabLabel(k)}</button>`)}
      <button class="copy-all" title="Усі кроки цієї вкладки одним текстом" onClick=${copyAll}>Скопіювати все</button></div>
    ${tabs[tab].map((s) => html`<${Step} s=${s} />`)}
    <div class="actions"><button onClick=${copyAll}>Скопіювати все</button><button class="primary" onClick=${done}>Готово</button></div>
  </${Modal}>`;
}

// ---------- edit agent: role, area, repository ----------
export function AgentEdit({ roomId, agent, repos, onClose }) {
  const [f, setF] = useState({ roleTitle: agent.role_title || "", paths: agent.paths.join(", "), repoId: agent.repo_id || "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api(`/api/rooms/${roomId}/agents/${agent.id}`, { method: "PATCH", body: f });
      toast(`${agent.name}: збережено. Агент отримав повідомлення про зміни`);
      onClose();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return html`<${Modal} onClose=${onClose}>
    <h2>Змінити агента: ${agent.name}</h2>
    <p class="muted">${AGENT_TYPES[agent.agent_type]} · веде ${agent.owner}. Ім'я й тип не змінюються.</p>
    <label class="f">Роль</label><input value=${f.roleTitle} placeholder="Frontend (React)" onInput=${set("roleTitle")} />
    <label class="f">Зона відповідальності (шляхи через кому)</label><input value=${f.paths} placeholder="frontend/**, shared/ui/**" onInput=${set("paths")} />
    <label class="f">Репозиторій</label><select value=${f.repoId} onChange=${set("repoId")}><option value="">— не вказано —</option>${repos.map((r) => html`<option value=${r.id}>${r.full_name}</option>`)}</select>
    <p class="dim small" style="margin-top:12px">Рядки «Role» і «Area» у профілі <code>${`/agents/${agent.name}/profile.md`}</code> оновляться самі (нова версія). Агент отримає особисте повідомлення про зміни.</p>
    ${err && html`<div class="err">${err}</div>`}
    <div class="actions"><button onClick=${onClose}>Скасувати</button><button class="primary" disabled=${busy} onClick=${save}>Зберегти</button></div>
  </${Modal}>`;
}

// ---------- create agent ----------
export function CreateAgent({ roomId, repos, me, onCreated, onClose }) {
  const [f, setF] = useState({ agentType: "claude", name: "", roleTitle: "", paths: "", repoId: repos[0]?.id || "", profile: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const suggested = `${f.agentType}-${(f.roleTitle.split(/[\s/(,]/)[0] || me.username).toLowerCase()}`.replace(/[^a-z0-9_-]/g, "");
  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api(`/api/rooms/${roomId}/agents`, { method: "POST", body: { ...f, name: f.name || suggested, paths: f.paths } });
      onCreated(r);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return html`<${Modal} onClose=${onClose}>
    <h2>Підключити свого агента</h2>
    <p class="muted">Агент належить тобі: лише ти можеш змінювати його профіль, токен і паузу.</p>
    <div class="grid2">
      <div><label class="f">Агент</label><select value=${f.agentType} onChange=${set("agentType")}>${Object.entries(AGENT_TYPES).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></div>
      <div><label class="f">Ім'я в кімнаті</label><input value=${f.name} placeholder=${suggested} onInput=${set("name")} /></div>
      <div><label class="f">Роль</label><input value=${f.roleTitle} placeholder="Frontend (React)" onInput=${set("roleTitle")} /></div>
      <div><label class="f">Репозиторій</label><select value=${f.repoId} onChange=${set("repoId")}><option value="">— не вказано —</option>${repos.map((r) => html`<option value=${r.id}>${r.full_name}</option>`)}</select></div>
    </div>
    <label class="f">Зона відповідальності (шляхи через кому)</label><input value=${f.paths} placeholder="frontend/**, shared/ui/**" onInput=${set("paths")} />
    <label class="f">Опис агента: роль, як працювати, що не чіпати (Markdown, можна пізніше в ${"/agents/<ім'я>/profile.md"})</label>
    <textarea rows="7" value=${f.profile} onInput=${set("profile")} placeholder=${"# Frontend agent\n\n## Responsibilities\n- UI in /frontend (React + Tailwind)\n\n## Rules\n- Never edit /backend\n- Every component has a test"}></textarea>
    ${err && html`<div class="err">${err}</div>`}
    <div class="actions"><button onClick=${onClose}>Скасувати</button><button class="primary" disabled=${busy} onClick=${submit}>Створити й показати команди</button></div>
  </${Modal}>`;
}
