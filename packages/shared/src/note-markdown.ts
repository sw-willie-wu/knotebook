import * as Y from "yjs";
import { YDOC_FRAGMENT } from "./ydoc.js";

// markdown 往返有損：wikilink 丟 targetNoteId（只剩 [[標題]] 文字）、mermaid 降級成
// codeBlock(language=mermaid)。這兩支還原；規則同 web 的 ai/apply.ts 與 mermaid-paste.ts：
// 唯一命中才綁、重名／找不到留純文字並計數；mermaid 的 code 一字不差。
// 另一條有損項、但**這裡不還原**（issue #153 實測）：連結的 title，`[x](url "title")`
// 的 `title` 會被整個丟掉——BlockNote 的 link inline content 只有 `href`，沒有 title
// 欄位可放，parse 之後那個字串就不存在了，沒有東西可以還原。
/** 與 apps/server/src/notes/service.ts:15 同一 pattern（server 那份不動、不共用）。 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 實測：`tryParseMarkdownToBlocks("")` 與 `("   \n  \n")` 都回傳**單一空 paragraph**
// （不是 `[]`）。刻意收斂到這個精確形，不用更寬鬆的「所有 block 都沒 content」條件——
// 那會把 `divider` 也誤判成空（`note-markdown.test.ts` 的 `isBlankParseResult([{ type:
// "divider" }])` 為 `false` 就是在守這件事）。
export function isBlankParseResult(blocks: unknown[]): boolean {
  if (blocks.length === 0) return true;
  const only = blocks[0] as { type?: string; content?: unknown; children?: unknown };
  return (
    blocks.length === 1 &&
    only?.type === "paragraph" &&
    (!Array.isArray(only.content) || only.content.length === 0) &&
    (!Array.isArray(only.children) || only.children.length === 0)
  );
}

type AnyBlock = { type: string; props?: Record<string, unknown>; content?: unknown; children?: AnyBlock[] };
type AnyInline = { type: string; text?: string; props?: Record<string, unknown>; styles?: Record<string, unknown> };

export function restoreMermaidBlocks<B>(blocks: B[]): B[] {
  return (blocks as AnyBlock[]).map(b => {
    const children = Array.isArray(b.children) && b.children.length > 0 ? restoreMermaidBlocks(b.children) : b.children;
    if (b.type === "codeBlock" && b.props?.language === "mermaid" && Array.isArray(b.content)) {
      const code = (b.content as Array<{ text?: string }>).map(c => c.text ?? "").join("");
      return { type: "mermaid", props: { code } } as unknown as B;
    }
    return (children === b.children ? b : { ...b, children }) as unknown as B;
  }) as B[];
}

export interface WikilinkTarget { id: string; title: string }

const WIKILINK_RE = /\[\[([^\[\]]+)\]\]/g;

function rebindInline(content: AnyInline[], notes: WikilinkTarget[]): [AnyInline[], number] {
  let unbound = 0;
  const out: AnyInline[] = [];
  for (const node of content) {
    if (node?.type !== "text" || typeof node.text !== "string" || !node.text.includes("[[")) { out.push(node); continue; }
    let last = 0;
    for (const m of node.text.matchAll(WIKILINK_RE)) {
      const title = m[1]!;
      const hits = notes.filter(n => n.title === title);
      if (m.index! > last) out.push({ ...node, text: node.text.slice(last, m.index) });
      if (hits.length === 1) out.push({ type: "wikilink", props: { targetNoteId: hits[0]!.id, snapshotTitle: title } });
      else { unbound += 1; out.push({ ...node, text: m[0] }); }
      last = m.index! + m[0].length;
    }
    if (last < node.text.length) out.push({ ...node, text: node.text.slice(last) });
  }
  return [out, unbound];
}

export function rebindWikilinks<B>(blocks: B[], notes: WikilinkTarget[], isInlineType: (type: string) => boolean): [B[], number] {
  let unbound = 0;
  const walk = (bs: AnyBlock[]): AnyBlock[] =>
    bs.map(b => {
      const next: AnyBlock = { ...b };
      if (isInlineType(b.type) && Array.isArray(b.content)) {
        const [content, n] = rebindInline(b.content as AnyInline[], notes);
        unbound += n;
        next.content = content;
      }
      if (Array.isArray(b.children) && b.children.length > 0) next.children = walk(b.children);
      return next;
    });
  return [walk(blocks as AnyBlock[]) as unknown as B[], unbound];
}

/**
 * 原 `link-sync.ts` 的同名函式搬來；純 Y.Doc 走訪，不需要編輯器。
 *
 * yjs 的非直覺事實：`createTreeWalker` 的 filter 只決定哪些節點被 **yield**，不影響
 * 是否往下走訪子節點——filter 回傳 false 的節點，其子節點仍會被走到。
 *
 * 回傳值刻意**去重＋排序**：呼叫端 `apps/web/src/collab/link-sync.ts` 用
 * `extractLinkTargets(doc).join(",")` 跟「上次成功提交的集合」做字串比較，順序不穩
 * 就會把「內容沒變」誤判成「變了」而多送一次 POST。
 */
export function extractLinkTargets(doc: Y.Doc): string[] {
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  const found: string[] = [];
  const walker = fragment.createTreeWalker((node): boolean => node instanceof Y.XmlElement && node.nodeName === "wikilink");
  for (const node of walker) {
    if (!(node instanceof Y.XmlElement)) continue;
    const targetNoteId = node.getAttribute("targetNoteId");
    if (typeof targetNoteId === "string" && UUID_RE.test(targetNoteId)) found.push(targetNoteId);
  }
  return [...new Set(found)].sort();
}
