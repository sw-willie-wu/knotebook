/**
 * #269：站內連結的**唯一判準**與 wikilink 純函式（spec 2026-10-13 site-links §4.2、§6）。
 * client（編輯器外掛、input rule、貼上、站內 AI）、server（MCP／REST 寫入、MCP 讀出、轉換工作）都只呼叫這裡；
 * 不准在別處另寫一份「這是不是站內網址」的判斷——兩份會漂。
 *
 * ⚠ import `./index.js` 是值層級的循環 import（index 在檔尾 `export * from "./site-link.js"`）：只在函式**呼叫時**
 * 用到 `normalizeHandle`／`normalizeSlug`／`extractRefUuid`，模組評估完畢前不碰，ESM 的循環在這個形下安全。
 */
import { extractRefUuid, normalizeHandle, normalizeSlug } from "./index.js";
import { UUID_RE } from "./note-markdown.js";

/** 段落錨點的區塊 id 形（同 `SECTION_ID_RE`）。不合格的值在所有讀端一律當 `""`（§4.1）。 */
export const BLOCK_ANCHOR_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeAnchor(value: unknown): string {
  return typeof value === "string" && BLOCK_ANCHOR_RE.test(value) ? value : "";
}

export type SiteNotePath =
  | { kind: "n"; handle: string; slug: string }
  | { kind: "g"; groupId: string; slug: string }
  | { kind: "ref"; ref: string };

export interface SiteNoteHref {
  path: SiteNotePath;
  anchorBlockId: string;
}

const ABSOLUTE_HTTP_RE = /^https?:/i;

/**
 * §6.1 規則（依序，任一不符 → null）。`siteOrigin`：web＝`window.location.origin`；server＝PUBLIC_URL 的 origin。
 * 判準寫成正面條件：只收列舉的三形，其餘一律 null（不逐一排除壞形）。
 */
export function parseSiteNoteHref(href: string, siteOrigin: string): SiteNoteHref | null {
  if (typeof href !== "string" || href === "" || href.trim() !== href) return null;
  const rootRelative = href.startsWith("/") && href[1] !== "/" && href[1] !== "\\";
  if (!rootRelative && !ABSOLUTE_HTTP_RE.test(href)) return null;
  let u: URL;
  try {
    // 非根相對的一律不給 base 剖析：`https:n/x`、`https:/n/x`、`HTTPS:../n/x` 帶 base 時會被當成同 scheme 的相對網址
    // 解析到本站（瀏覽器在別的頁面上會解到別處），§6.1-2 只收真正的絕對網址。
    u = rootRelative ? new URL(href, siteOrigin) : new URL(href);
  } catch {
    return null;
  }
  if (u.origin !== siteOrigin) return null;
  if (u.username !== "" || u.password !== "" || u.search !== "") return null;
  // `URL` 對 `?` 結尾（空 query）給 `search === ""`——A5 要擋「帶 query」，空 query 也是 query。
  if (href.includes("?")) return null;
  let anchorBlockId = "";
  if (u.hash !== "") {
    if (!u.hash.startsWith("#b-")) return null;
    const id = u.hash.slice(3);
    if (!BLOCK_ANCHOR_RE.test(id)) return null;
    anchorBlockId = id;
  }
  if (u.pathname.endsWith("/")) return null;
  let segs: string[];
  try {
    segs = u.pathname.split("/").slice(1).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segs.some((s) => s === "")) return null;
  const [head, a, b] = segs;
  if (segs.length === 3 && head === "n") {
    return { path: { kind: "n", handle: normalizeHandle(a!), slug: normalizeSlug(b!) }, anchorBlockId };
  }
  if (segs.length === 3 && head === "g") {
    if (!UUID_RE.test(a!)) return null;
    return { path: { kind: "g", groupId: a!.toLowerCase(), slug: normalizeSlug(b!) }, anchorBlockId };
  }
  if (segs.length === 2 && head === "notes") return { path: { kind: "ref", ref: a! }, anchorBlockId };
  return null;
}

export function wikilinkHref(id: string, anchor: string): string {
  return `/notes/${id}${anchor ? `#b-${anchor}` : ""}`;
}

export interface WikilinkProps {
  targetNoteId: string;
  snapshotTitle: string;
  label: string;
  anchorBlockId: string;
}

export interface SiteLinkTarget {
  id: string;
  title: string;
}

/** §6.3：逐字 `===`，不 trim、不轉大小寫。`snapshotTitle` 取原文字（A3）。 */
export function wikilinkPropsFromLink(input: { text: string; href: string; target: SiteLinkTarget; anchorBlockId: string }): WikilinkProps {
  const { text, href, target, anchorBlockId } = input;
  const label = text === "" || text === target.title || text === href ? "" : text;
  return { targetNoteId: target.id.toLowerCase(), snapshotTitle: text !== "" ? text : target.title, label, anchorBlockId };
}

/** §4.2：`label` 非空用 label；否則可用的現行標題，沒有就 `snapshotTitle`。可能為空字串。 */
export function wikilinkDisplayText(props: Partial<WikilinkProps>, liveTitle?: string): string {
  const label = typeof props.label === "string" ? props.label : "";
  if (label !== "") return label;
  return liveTitle ?? (typeof props.snapshotTitle === "string" ? props.snapshotTitle : "");
}

/** 永不為空的版本：顯示文字為空時退到 `wikilinkHref`（§7.3 匯出、§13.2 diff 單位的後備鏈終點）。 */
export function wikilinkVisibleText(props: Partial<WikilinkProps>, liveTitle?: string): string {
  return wikilinkDisplayText(props, liveTitle) || wikilinkHref(String(props.targetNoteId ?? ""), normalizeAnchor(props.anchorBlockId));
}

export interface SiteLinkCandidate {
  id: string;
  title: string;
  slug: string;
  groupId: string | null;
  ownerHandle: string | null;
}

/** §6.5：同步比對（server 預取的可見清單、web 的 `["notes"]` 快取共用）。轉址表／prev_slug／legacy slug 一律不命中（N1）。 */
export function resolveFromList<T extends SiteLinkCandidate>(path: SiteNotePath, list: readonly T[]): T | null {
  switch (path.kind) {
    case "n":
      return list.find((n) => (n.groupId ?? null) === null && n.ownerHandle === path.handle && n.slug === path.slug) ?? null;
    case "g":
      return list.find((n) => n.groupId === path.groupId && n.slug === path.slug) ?? null;
    case "ref": {
      const id = extractRefUuid(path.ref);
      return id === null ? null : (list.find((n) => n.id.toLowerCase() === id) ?? null);
    }
  }
}

/** link 內所有 text 片段串接（樣式丟棄，§6.3、§17-1）。 */
export function linkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "string" ? c : typeof (c as { text?: unknown })?.text === "string" ? (c as { text: string }).text : "")).join("");
}

export type InlineArrayMapper = (inline: unknown[]) => unknown[];
type AnyBlock = { type: string; content?: unknown; children?: unknown[] };
type TableCellObject = { type: "tableCell"; content?: unknown };

function mapTableContent(content: { type: "tableContent"; rows?: Array<{ cells?: unknown[] }> }, map: InlineArrayMapper): unknown {
  let changed = false;
  const rows = (content.rows ?? []).map((row) => {
    let rowChanged = false;
    const cells = (row.cells ?? []).map((cell) => {
      if (Array.isArray(cell)) {
        const next = map(cell);
        if (next !== cell) rowChanged = true;
        return next;
      }
      const obj = cell as TableCellObject;
      if (obj && obj.type === "tableCell" && Array.isArray(obj.content)) {
        const next = map(obj.content);
        if (next === obj.content) return cell;
        rowChanged = true;
        return { ...obj, content: next };
      }
      return cell;
    });
    if (!rowChanged) return row;
    changed = true;
    return { ...row, cells };
  });
  return changed ? { ...content, rows } : content;
}

/**
 * §6.2 的走訪器（`rebindWikilinks` 與 `convertSiteLinks` 共用）：inline 陣列 content（`isInlineType` 有給時要它為真）、
 * `tableContent` 的每個 cell（兩種形，不看 `isInlineType`）、`children` 遞迴。copy-on-write：`map` 回同一陣列就不換外層。
 */
export function mapInlineArrays<B>(blocks: B[], map: InlineArrayMapper, isInlineType?: (type: string) => boolean): B[] {
  let changed = false;
  const out = (blocks as unknown as AnyBlock[]).map((block) => {
    let next: AnyBlock = block;
    const content = block.content;
    if (Array.isArray(content) && (isInlineType === undefined || isInlineType(block.type))) {
      const mapped = map(content);
      if (mapped !== content) next = { ...next, content: mapped };
    } else if (content && typeof content === "object" && (content as { type?: unknown }).type === "tableContent") {
      const mapped = mapTableContent(content as { type: "tableContent" }, map);
      if (mapped !== content) next = { ...next, content: mapped };
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      const kids = mapInlineArrays(block.children, map, isInlineType);
      if (kids !== block.children) next = { ...next, children: kids };
    }
    if (next !== block) changed = true;
    return next;
  });
  return (changed ? out : blocks) as B[];
}

export type SiteLinkResolve = (href: string, parsed: SiteNoteHref) => SiteLinkTarget | null;

export interface ConvertStats {
  converted: number;
  unresolved: number;
}

function convertInline(inline: unknown[], resolve: SiteLinkResolve, siteOrigin: string, stats: ConvertStats): unknown[] {
  let changed = false;
  const out = inline.map((node) => {
    const n = node as { type?: unknown; href?: unknown; content?: unknown };
    if (n?.type !== "link" || typeof n.href !== "string") return node;
    const parsed = parseSiteNoteHref(n.href, siteOrigin);
    if (!parsed) return node;
    const target = resolve(n.href, parsed);
    if (!target) {
      stats.unresolved += 1;
      return node;
    }
    stats.converted += 1;
    changed = true;
    return { type: "wikilink", props: wikilinkPropsFromLink({ text: linkText(n.content), href: n.href, target, anchorBlockId: parsed.anchorBlockId }) };
  });
  return changed ? out : inline;
}

/** 一個 block 的 `content`（inline 陣列或 `tableContent`）上做 §6.2 的轉換；沒有變動回原物件。 */
export function convertSiteLinksInContent(content: unknown, resolve: SiteLinkResolve, siteOrigin: string, stats: ConvertStats): unknown {
  if (Array.isArray(content)) return convertInline(content, resolve, siteOrigin, stats);
  if (content && typeof content === "object" && (content as { type?: unknown }).type === "tableContent") {
    return mapTableContent(content as { type: "tableContent" }, (inline) => convertInline(inline, resolve, siteOrigin, stats));
  }
  return content;
}

/** §6.2：block JSON 陣列 → `[轉換後, { converted, unresolved }]`。輸入不改寫。 */
export function convertSiteLinks<B>(blocks: B[], resolve: SiteLinkResolve, siteOrigin: string): [B[], ConvertStats] {
  const stats: ConvertStats = { converted: 0, unresolved: 0 };
  const out = mapInlineArrays(blocks, (inline) => convertInline(inline, resolve, siteOrigin, stats));
  return [out, stats];
}

/**
 * MCP 讀（§9.1）與站內 AI（§9.4）的匯出副本改寫：wikilink → `{ type:"link", href: wikilinkHref, content:[顯示文字] }`。
 * 顯示文字＝`wikilinkVisibleText(props, titleOf(id))`——`titleOf` 只給讀者看得到的目標，看不到的退到 `snapshotTitle`。
 * 輸入不改寫（copy-on-write）；不依賴 `toExternalHTML` 的形，所以 PR1／PR2 任一狀態下 MCP 讀出的形都相同。
 */
export function wikilinksToLinks<B>(blocks: readonly B[], titleOf: (id: string) => string | undefined): B[] {
  const rewrite: InlineArrayMapper = (inline) => {
    let changed = false;
    const out = inline.map((node) => {
      const n = node as { type?: unknown; props?: Partial<WikilinkProps> };
      if (n?.type !== "wikilink") return node;
      changed = true;
      const props = n.props ?? {};
      const id = String(props.targetNoteId ?? "");
      const href = wikilinkHref(id, normalizeAnchor(props.anchorBlockId));
      return { type: "link", href, content: [{ type: "text", text: wikilinkVisibleText(props, titleOf(id)), styles: {} }] };
    });
    return changed ? out : inline;
  };
  return mapInlineArrays([...blocks], rewrite);
}
