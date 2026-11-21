import { randomBytes } from "node:crypto";
import { editorLocator, reEscape } from "./helpers.js";
import { hoverCardOf, iconOf } from "./knowledge-helpers.js";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

/** Shared by the markdown specs (68, 69): an agent that holds a PAT and sends it from a cookie-less context, over MCP, REST and the file endpoints. */

export interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

export interface Agent {
  origin: string;
  pat: string;
  patId: string;
  /** Sends the requests; it has no cookies, so the PAT is the only credential. */
  anon: BrowserContext;
  /** The signed-in page whose user owns the PAT. */
  owner: Page;
}

export async function createAgent(browser: Browser, owner: Page): Promise<Agent> {
  const origin = new URL(owner.url()).origin;
  const created = await owner.request.post("/api/auth/tokens", {
    data: { name: `md-e2e-${randomBytes(4).toString("hex")}`, scope: "notes:read notes:write", expiresInDays: 30 },
  });
  expect(created.status(), await created.text()).toBe(201);
  const token = (await created.json()) as { id: string; token: string };
  return { origin, pat: token.token, patId: token.id, anon: await browser.newContext(), owner };
}

export async function closeAgent(agent: Agent | undefined): Promise<void> {
  if (!agent) return;
  try {
    await agent.owner.request.delete(`/api/auth/tokens/${agent.patId}`);
  } finally {
    await agent.anon.close();
  }
}

const mcpHeaders = (pat: string) => ({ Authorization: `Bearer ${pat}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" });

/** The tool's own result, error or not: a failed tool call is still a 200 JSON-RPC reply. */
export async function callTool(agent: Agent, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await agent.anon.request.post(`${agent.origin}/api/mcp`, {
    headers: mcpHeaders(agent.pat),
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.status(), await res.text()).toBe(200);
  const rpc = (await res.json()) as { result?: ToolResult };
  expect(rpc.result, JSON.stringify(rpc)).toBeDefined();
  return rpc.result!;
}

export async function callToolOk(agent: Agent, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await callTool(agent, name, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result;
}

export function errorText(result: ToolResult): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("\n");
}

export interface SectionRead {
  sectionId: string;
  markdown: string;
  fingerprint: string;
}

/** Reads the section under `heading` through read_note_outline and read_note_section. */
export async function readSection(agent: Agent, noteId: string, heading: string): Promise<SectionRead> {
  const outline = await callToolOk(agent, "read_note_outline", { note_id: noteId });
  const sections = outline.structuredContent!.sections as Array<{ sectionId: string; heading: string }>;
  const entry = sections.find((s) => s.heading === heading);
  expect(entry, JSON.stringify(sections)).toBeDefined();
  const read = await callToolOk(agent, "read_note_section", { note_id: noteId, section_id: entry!.sectionId });
  const body = read.structuredContent as { section: { markdown: string; fingerprint?: string }; truncated: boolean };
  expect(body.truncated).toBe(false);
  expect(body.section.fingerprint).toBeTruthy();
  return { sectionId: entry!.sectionId, markdown: body.section.markdown, fingerprint: body.section.fingerprint! };
}

/** The whole note as REST returns it. */
export async function restMarkdown(agent: Agent, noteId: string): Promise<string> {
  const res = await agent.anon.request.get(`${agent.origin}/api/notes/${noteId}/content`, { headers: { Authorization: `Bearer ${agent.pat}` } });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { markdown: string }).markdown;
}

export function knowledgeComment(lines: readonly string[]): string {
  return `<!-- knotebook:knowledge\n${lines.join("\n")}\n-->`;
}

/** The `id:` line of the knowledge comment in `markdown`; there must be exactly one comment. */
export function knowledgeIdIn(markdown: string): string {
  const ids = [...markdown.matchAll(/^id: (k_[0-9a-f]{8})$/gm)].map((m) => m[1]!);
  expect(ids, markdown).toHaveLength(1);
  return ids[0]!;
}

export interface FileAccess {
  agent: Agent;
  token: string;
  auth: { Authorization: string };
}

/** A bulk token from open_notes_as_files; `space: "shared"` covers only notes others shared with the user. */
export async function openFiles(agent: Agent, args: Record<string, unknown> = {}): Promise<FileAccess> {
  const result = await callToolOk(agent, "open_notes_as_files", args);
  const sc = result.structuredContent as { token: string; access: string };
  expect(sc.token).toMatch(/^knbt_/);
  expect(sc.access).toBe("write");
  return { agent, token: sc.token, auth: { Authorization: `Bearer ${sc.token}` } };
}

export async function revokeFiles(access: FileAccess | undefined): Promise<void> {
  if (!access) return;
  try {
    await access.agent.anon.request.delete(`${access.agent.origin}/api/transfer/token`, { headers: access.auth });
  } catch {
    // Best effort: the original failure matters more.
  }
}

export async function downloadFile(access: FileAccess, noteId: string): Promise<string> {
  const res = await access.agent.anon.request.get(`${access.agent.origin}/api/transfer/notes/${noteId}`, { headers: access.auth });
  expect(res.status(), await res.text()).toBe(200);
  return res.text();
}

export interface WriteBack {
  status: number;
  body: Record<string, unknown>;
}

export async function writeFile(access: FileAccess, file: string): Promise<WriteBack> {
  const res: Awaited<ReturnType<APIRequestContext["put"]>> = await access.agent.anon.request.put(`${access.agent.origin}/api/transfer/notes`, {
    headers: { ...access.auth, "Content-Type": "text/markdown; charset=utf-8" },
    data: Buffer.from(file, "utf8"),
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** A heading by its text. An agent that just wrote it has its cursor label inside the heading, so the accessible name ends with the text rather than equals it. */
export function headingWithText(page: Page, text: string): Locator {
  return editorLocator(page).getByRole("heading", { name: new RegExp(`${reEscape(text)}$`) });
}

/** Opens the hover card of the page's one "Not verified" icon afresh: a card that is still open from earlier keeps what it showed when it opened. */
export async function expectHoverCard(page: Page, text: string): Promise<void> {
  await expect(async () => {
    await page.mouse.move(0, 0);
    await expect(hoverCardOf(page)).toBeHidden({ timeout: 2_000 });
    await iconOf(page, "Not verified").hover();
    await expect(hoverCardOf(page)).toContainText(text, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/** Replaces the one line that equals `old`. */
export function replaceLine(file: string, old: string, neu: string): string {
  const lines = file.split("\n");
  const hits = lines.flatMap((l, i) => (l === old ? [i] : []));
  expect(hits, `the file should have exactly one line "${old}"`).toHaveLength(1);
  lines[hits[0]!] = neu;
  return lines.join("\n");
}

/** Replaces the first line that starts with `prefix`. */
export function replaceLineStartingWith(file: string, prefix: string, neu: string): string {
  const lines = file.split("\n");
  const at = lines.findIndex((l) => l.startsWith(prefix));
  expect(at, `no line starts with "${prefix}"`).toBeGreaterThanOrEqual(0);
  lines[at] = neu;
  return lines.join("\n");
}
