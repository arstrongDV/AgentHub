import { h, render } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import htm from "htm";
export const html = htm.bind(h);
export { h, render, useState, useEffect, useRef, useCallback };

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-requested-with": "agent-rooms" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

let toastTimer;
export function toast(text) {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = text; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}
export const tryToast = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };

export function copy(text) {
  const ok = () => toast("Скопійовано");
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  function fallback() { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); ok(); } catch {} t.remove(); }
}

export const Code = ({ text }) => html`<div class="code">${text}<button class="sm" onClick=${() => copy(text)}>Копіювати</button></div>`;

export function navigate(path) { history.pushState({}, "", path); window.dispatchEvent(new Event("route")); }
export const Link = ({ href, children, ...p }) => html`<a href=${href} onClick=${(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(href); }} ...${p}>${children}</a>`;

export function ago(iso) {
  if (!iso) return "ніколи";
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 45) return "щойно";
  if (s < 3600) return `${Math.round(s / 60)} хв тому`;
  if (s < 86400) return `${Math.round(s / 3600)} год тому`;
  return new Date(iso).toLocaleDateString();
}
export const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const activity = (iso) => { if (!iso) return ""; const s = (Date.now() - new Date(iso)) / 1000; return s < 180 ? "active" : s < 1200 ? "recent" : ""; };

// `persistent`: Escape and backdrop clicks are ignored; the modal closes only via its own buttons
// (used where closing by accident loses something for good, e.g. a one-time agent token).
export function Modal({ onClose, children, wide, persistent }) {
  const latest = useRef(); latest.current = { onClose, persistent };
  const downOnBackdrop = useRef(false);
  useEffect(() => {
    const k = (e) => e.key === "Escape" && !latest.current.persistent && latest.current.onClose();
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);
  // Close only on a full click on the backdrop: press AND release on it. A press that starts inside the
  // modal (text selection dragged out), on the backdrop's scrollbar, or that is released inside the modal
  // must not close it. (The browser reports a press/release on different elements as a click on their
  // common ancestor — the backdrop — so `click` alone is not enough.)
  const onMouseDown = (e) => {
    const el = e.currentTarget;
    downOnBackdrop.current = e.target === el && e.offsetX < el.clientWidth && e.offsetY < el.clientHeight;
  };
  const onMouseUp = (e) => { if (e.target !== e.currentTarget) downOnBackdrop.current = false; };
  const onClick = (e) => {
    const ok = downOnBackdrop.current && e.target === e.currentTarget;
    downOnBackdrop.current = false;
    if (ok && !persistent) onClose();
  };
  return html`<div class="overlay" onMouseDown=${onMouseDown} onMouseUp=${onMouseUp} onClick=${onClick}>
    <div class="modal" style=${wide ? "max-width:980px" : ""}>${children}</div></div>`;
}

// Data hook: refetches when `deps` change (room live tick included).
export function useData(path, deps = []) {
  const [state, set] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api(path).then((data) => alive && set({ data, error: null, loading: false }), (e) => alive && set((s) => ({ ...s, error: e.message, loading: false })));
    return () => { alive = false; };
  }, [path, ...deps]);
  return state;
}

// ---------- tiny, safe markdown renderer ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
export function mdToHtml(src) {
  const lines = String(src || "").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const out = []; let list = null, code = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (code !== null) { if (/^```/.test(line)) { out.push(`<pre><code>${esc(code)}</code></pre>`); code = null; } else code += line + "\n"; continue; }
    if (/^```/.test(line)) { closeList(); code = ""; continue; }
    if (line.startsWith("---") && line.trim() === "---") { closeList(); out.push("<hr>"); continue; }
    const hm = /^(#{1,4})\s+(.*)/.exec(line);
    if (hm) { closeList(); out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); continue; }
    const li = /^\s*[-*]\s+(\[( |x)\]\s+)?(.*)/.exec(line);
    const oli = /^\s*\d+\.\s+(.*)/.exec(line);
    if (li) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${li[1] ? (li[2] === "x" ? "☑ " : "☐ ") : ""}${inline(li[3])}</li>`); continue; }
    if (oli) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(oli[1])}</li>`); continue; }
    closeList();
    if (/^>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`); continue; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (code !== null) out.push(`<pre><code>${esc(code)}</code></pre>`);
  closeList();
  return out.join("\n");
}
export const Markdown = ({ text }) => html`<div class="md" dangerouslySetInnerHTML=${{ __html: mdToHtml(text) }}></div>`;

// ---------- line diff (LCS) ----------
export function lineDiff(a, b) {
  const x = String(a).split("\n"), y = String(b).split("\n");
  if (x.length * y.length > 4e6) return [{ t: "del", s: "(file too large to diff)" }];
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: "", s: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "del", s: x[i++] });
    else out.push({ t: "add", s: y[j++] });
  }
  while (i < n) out.push({ t: "del", s: x[i++] });
  while (j < m) out.push({ t: "add", s: y[j++] });
  return out;
}

export const AGENT_TYPES = { claude: "Claude Code", cursor: "Cursor", codex: "Codex", other: "Інший агент" };
export const PHASES = [["setup", "Підготовка"], ["planning", "Планування"], ["plan_review", "Погодження"], ["executing", "Виконання"], ["done", "Готово"]];
export const STATUS = { todo: "To do", in_progress: "В роботі", blocked: "Заблоковано", review: "Рев'ю", done: "Готово" };
export const KINDS = { decision: "Рішення", api_change: "Зміна API", env_change: "Env / залежності", blocker: "Блокер", handoff: "Передача", milestone: "Етап", plan_change: "Зміна плану" };
