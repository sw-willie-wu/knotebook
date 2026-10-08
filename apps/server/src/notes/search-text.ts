/**
 * #93 §4：全文索引的內文抽取（server 專用；spec 2026-10-08-93 §4.1–§4.6）。
 *
 * - **以位置對應 `sectionize`**（§4.2）：第 k 段吃掉 `topLevelContainers` 接下來的 `blockIds.length` 顆——不以 id 查表
 *   （id 可重複、可非字串）。`heading` 與 outline 同源（`sectionize` 的 heading）。
 * - **整篇前提（m3）**：任何頂層 container 的 `id` 不是字串或是空字串 → 整篇不寫 body 列、`capped`、`indexedUnits` 0。
 *   這種文件 `outlineOf` 直接 throw（`notes/editing/fingerprint.ts:20`），兩支讀取工具本來就讀不了，搜尋不得交出讀不到的 sectionId。
 * - **段落入索引的條件**：`sectionId` 原值是字串且符合 `SECTION_ID_RE`、在本篇段落 id 序列中**第一次出現**（＝`read.ts:75`
 *   的 `outline.find`——所以不論該段有沒有入索引，id 一律記為「出現過」）、body 非空。
 * - **走訪是迭代的**（顯式 stack）：深度是 client 可控的（`collab/store.ts:74-79`）。wikilink 輸出 `[[snapshotTitle]]`、
 *   mermaid 輸出 `code` 屬性；媒體的 caption／name／url 一律不收（§1.3）。
 * - **分隔延遲輸出**（plan 裁定 R-sep）：進入非 inline 元素只標記「下一段文字前要分隔」，有字要輸出時才補 `\n`——
 *   所以 body 沒有開頭／結尾／連續的結構分隔，「body 非空」才有意義。文字本身的空白不壓縮（摘錄輸出時才壓，§8.3）。
 * - **清洗**（§4.4）：NUL 與落單代理換 U+FFFD（長度不變）——NUL 會讓整個交易 22021；落單代理經 node-postgres 本來就會變
 *   U+FFFD，明換之後「存的＝算雜湊的＝回給模型的」三者一致。
 * - **上限**（§4.4）：body 合計 `SEARCH_INDEX_NOTE_MAX` code unit（超過的那段截到剩餘額度、其後不入）、段落列
 *   `SEARCH_INDEX_SECTIONS_MAX`（丟棄而不併入最後一列）、heading 存前 `SEARCH_HEADING_MAX`；切點不切代理對。
 *   任一上限丟了**有內容的**段落 → `capped`。
 * - **任何規則或上限改動都要把 `SEARCH_EXTRACTOR_VERSION` +1**（回填會重做舊版本的筆記，§6）。
 */
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { SECTION_ID_RE, sectionize, topLevelContainers } from "@knotebook/shared";
import { truncateCodeUnits } from "../mcp/limits.js";

export const SEARCH_EXTRACTOR_VERSION = 1;
export const SEARCH_INDEX_NOTE_MAX = 1_048_576;
export const SEARCH_INDEX_SECTIONS_MAX = 2000;
export const SEARCH_HEADING_MAX = 1000;

export interface SearchSectionRow {
  sectionId: string;
  ord: number;
  heading: string;
  body: string;
}

export interface SearchExtract {
  rows: SearchSectionRow[];
  contentHash: string;
  indexedUnits: number;
  capped: boolean;
  extractorVersion: number;
}

const UNSTORABLE_RE = /\0|\p{Surrogate}/gu;

/** NUL 與落單代理 → U+FFFD（u 旗標下成對代理是一個 code point，不被 `\p{Surrogate}` 命中）。 */
export function sanitizeForIndex(s: string): string {
  return s.replace(UNSTORABLE_RE, "�");
}

function deltaText(t: Y.XmlText): string {
  return (t.toDelta() as Array<{ insert: unknown }>).map(d => (typeof d.insert === "string" ? d.insert : "")).join("");
}

/** 一顆頂層 container 的可搜文字（迭代、分隔延遲輸出）。 */
function containerSearchText(container: Y.XmlElement): string {
  let out = "";
  let pendingSep = false;
  const emit = (s: string): void => {
    if (s.length === 0) return;
    if (pendingSep && out.length > 0) out += "\n";
    pendingSep = false;
    out += s;
  };
  const stack: unknown[] = [container];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node instanceof Y.XmlText) {
      emit(deltaText(node));
      continue;
    }
    if (!(node instanceof Y.XmlElement)) continue; // Y.XmlHook 等：不深入（同 collab/store.ts 的已知範疇）
    if (node.nodeName === "wikilink") {
      const title: unknown = node.getAttribute("snapshotTitle");
      emit(`[[${typeof title === "string" ? title : ""}]]`);
      continue;
    }
    pendingSep = true;
    if (node.nodeName === "mermaid") {
      const code: unknown = node.getAttribute("code");
      if (typeof code === "string") emit(code);
      continue;
    }
    const kids = node.toArray();
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return out;
}

/**
 * `capped` 一併入雜湊（#93 Task 4 review I-1）：rows 相同但 capped 不同是常態可達的（恰 2000 段→加第 2001 段；空筆記→
 * 出現空 id container）。不入雜湊的話索引交易第 4 步與 store 的 bump 都只比 hash，會回 `unchanged`、狀態列的 `capped` 停在舊值。
 */
export function searchContentHash(version: number, rows: SearchSectionRow[], capped: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify([version, capped, rows.map(r => [r.sectionId, r.ord, r.heading, r.body])]))
    .digest("hex");
}

function finish(rows: SearchSectionRow[], indexedUnits: number, capped: boolean): SearchExtract {
  return { rows, indexedUnits, capped, contentHash: searchContentHash(SEARCH_EXTRACTOR_VERSION, rows, capped), extractorVersion: SEARCH_EXTRACTOR_VERSION };
}

export function extractSearchSections(fragment: Y.XmlFragment): SearchExtract {
  const containers = topLevelContainers(fragment);
  for (const c of containers) {
    const id: unknown = c.getAttribute("id");
    if (typeof id !== "string" || id === "") return finish([], 0, true);
  }
  const sections = sectionize(fragment);
  const rows: SearchSectionRow[] = [];
  const seen = new Set<unknown>();
  let units = 0;
  let capped = false;
  let bodyFull = false;
  let pos = 0;
  for (let k = 0; k < sections.length; k += 1) {
    const s = sections[k]!;
    const mine = containers.slice(pos, pos + s.blockIds.length);
    pos += s.blockIds.length;
    const rawId: unknown = s.sectionId;
    const first = !seen.has(rawId);
    seen.add(rawId);
    if (typeof rawId !== "string" || !SECTION_ID_RE.test(rawId) || !first) continue;
    let body = sanitizeForIndex(mine.map(containerSearchText).filter(t => t.length > 0).join("\n"));
    if (body.length === 0) continue;
    if (rows.length >= SEARCH_INDEX_SECTIONS_MAX || bodyFull) {
      capped = true;
      continue;
    }
    if (units + body.length > SEARCH_INDEX_NOTE_MAX) {
      body = truncateCodeUnits(body, SEARCH_INDEX_NOTE_MAX - units).text;
      capped = true;
      bodyFull = true; // §4.4「其後各段不入索引」：退格後 units 可能停在上限 −1，不能靠 units 判斷
      if (body.length === 0) continue;
    }
    units += body.length;
    rows.push({ sectionId: rawId, ord: k, heading: truncateCodeUnits(sanitizeForIndex(s.heading), SEARCH_HEADING_MAX).text, body });
  }
  return finish(rows, units, capped);
}
