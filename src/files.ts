// Uploaded PDFs (requirements, architecture, …). The original file is kept next to its doc in `doc_files`
// so humans can view/download it; the doc's text content is extracted from the PDF, so agents read it like
// any other doc (get_context, read_doc, search_docs). Agents can fetch the original through a signed link.
import crypto from "node:crypto";
import type { Response } from "express";
import { extractText, getDocumentProxy } from "unpdf";
import { db, now, tx } from "./db.js";
import * as C from "./core.js";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 290_000; // docs hold at most 300k chars
const LINK_TTL = 3600;
// Signed links survive restarts only if the secret is fixed; a random one just makes old links expire early.
const SECRET = process.env.FILE_LINK_SECRET || crypto.randomBytes(32).toString("hex");

export type DocFile = {
  doc_id: number; version: number; name: string; mime: string; size: number; pages: number; text_chars: number;
  uploaded_by: string; created_at: string;
};
const META = "doc_id, version, name, mime, size, pages, text_chars, uploaded_by, created_at";

// The file in effect at a doc version: a text-only edit after an upload keeps pointing at that upload.
export const fileMeta = (docId: number, atVersion: number) =>
  db.prepare(`SELECT ${META} FROM doc_files WHERE doc_id = ? AND version <= ? ORDER BY version DESC LIMIT 1`)
    .get(docId, atVersion) as DocFile | undefined;
const fileData = (docId: number, version: number) =>
  db.prepare(`SELECT ${META}, data FROM doc_files WHERE doc_id = ? AND version = ?`)
    .get(docId, version) as (DocFile & { data: Uint8Array }) | undefined;

async function pdfPages(data: Uint8Array): Promise<string[]> {
  try {
    const pdf = await getDocumentProxy(data);
    const { text } = await extractText(pdf, { mergePages: false });
    await (pdf as any).destroy?.(); // frees pdf.js resources (not in the published types)
    return text;
  } catch (e: any) {
    if (/password/i.test(String(e?.message || e?.name))) C.fail("this PDF is password-protected: remove the password and upload it again");
    C.fail("could not read this PDF (the file may be damaged)");
  }
}

// What agents read. English on purpose, like the other agent-facing texts.
function agentText(name: string, pages: string[]) {
  const chars = pages.reduce((n, t) => n + t.trim().length, 0);
  const head = `> Text extracted automatically from the uploaded PDF "${name}" (${pages.length} page${pages.length === 1 ? "" : "s"}). ` +
    `Images and diagrams are not included: read_doc this path to get a download link for the original PDF.`;
  if (!chars) {
    return { chars, content: `${head}\n\n**This PDF has no text layer (scanned or image-only), so its text could not be extracted.** ` +
      `Download the original PDF, or ask the humans to write the key points into this document.` };
  }
  let body = pages.map((t, i) => `## Page ${i + 1}\n\n${t.replace(/\n{3,}/g, "\n\n").trim() || "_(no text on this page: probably an image or a diagram)_"}`).join("\n\n");
  if (body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT)}\n\n…(text truncated: the PDF is longer than a document can hold, see the original PDF for the rest)`;
  return { chars, content: `${head}\n\n${body}` };
}

export async function uploadPdf(roomId: string, rawPath: string, data: Buffer, fileName: string, actor: C.Actor, memberRole?: string) {
  const path = C.normDocPath(rawPath);
  if (!path.endsWith(".pdf")) C.fail("the path of a PDF document must end with .pdf");
  if (!C.canEditDoc(roomId, path, actor, memberRole)) C.fail(`you cannot edit ${path}`, 403);
  if (!data.length) C.fail("the file is empty");
  if (data.length > MAX_PDF_BYTES) C.fail(`PDF is too large (max ${MAX_PDF_BYTES / 1024 / 1024} MB)`, 413);
  if (data.subarray(0, 1024).indexOf("%PDF-") < 0) C.fail("this is not a PDF file");
  const name = String(fileName || "").replace(/[\u0000-\u001f"\\/]/g, "").trim().slice(0, 200) || path.split("/").pop()!;
  // pdf.js may take ownership of the buffer it is given, so it gets a copy; `data` is what we store.
  const pages = await pdfPages(new Uint8Array(data));
  const { content, chars } = agentText(name, pages);
  let version = 1, isNew = true;
  tx(() => {
    const cur = C.getDoc(roomId, path); // read again: the extraction above was async
    let docId: number;
    if (cur) {
      isNew = false; version = cur.version + 1; docId = cur.id;
      db.prepare("UPDATE docs SET content = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(content, version, actor.name, now(), docId);
    } else {
      docId = Number(db.prepare("INSERT INTO docs (room_id, path, content, version, updated_by, updated_at) VALUES (?,?,?,?,?,?)")
        .run(roomId, path, content, 1, actor.name, now()).lastInsertRowid);
    }
    db.prepare("INSERT INTO doc_versions (doc_id, version, content, updated_by, created_at) VALUES (?,?,?,?,?)").run(docId, version, content, actor.name, now());
    db.prepare(`INSERT INTO doc_files (doc_id, version, name, mime, size, pages, text_chars, data, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(docId, version, name, "application/pdf", data.length, pages.length, chars, data, actor.name, now());
  });
  C.activity(roomId, actor, "doc", `${actor.name} ${isNew ? "uploaded" : "uploaded a new version of"} ${path} (PDF, ${pages.length} pages, v${version})`, { path, version });
  return { path, version, pages: pages.length, chars };
}

// ---------- serving ----------
function send(res: Response, f: DocFile & { data: Uint8Array }, download: boolean) {
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/[";\\]/g, "");
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader("X-Frame-Options", "SAMEORIGIN"); // the doc view embeds it in an iframe (everything else stays DENY)
  res.setHeader("Cache-Control", "private, max-age=600");
  res.end(Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength));
}

// For room members (session auth is checked by the router). `v` picks the file in effect at that doc version.
export function sendDocFile(res: Response, roomId: string, rawPath: string, v: number | undefined, download: boolean) {
  const d = C.getDoc(roomId, C.normDocPath(rawPath)) || C.fail("not found", 404);
  const meta = fileMeta(d.id, v || d.version) || C.fail("this document has no attached file", 404);
  send(res, fileData(d.id, meta.version)!, download);
}

// ---------- signed links for agents (they have no browser session) ----------
const mac = (s: string) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url").slice(0, 32);

export function signedFileLink(hubUrl: string, f: DocFile) {
  const body = `${f.doc_id}.${f.version}.${Math.floor(Date.now() / 1000) + LINK_TTL}`;
  return `${hubUrl}/api/files/${body}.${mac(body)}`;
}

export function sendSignedFile(res: Response, sig: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.([\w-]{32})$/.exec(sig);
  const valid = m && crypto.timingSafeEqual(Buffer.from(mac(`${m[1]}.${m[2]}.${m[3]}`)), Buffer.from(m[4])) && Number(m[3]) * 1000 > Date.now();
  const f = valid ? fileData(Number(m![1]), Number(m![2])) : undefined;
  if (!f) return res.status(404).type("text/plain").send("Link expired or file not found. Call read_doc again for a fresh link.\n");
  send(res, f, true);
}
