/**
 * #269 §8.4／§6.5：client 寫入路徑的站內連結轉換。
 * - `createSiteLinkConvertExtension`：tiptap extension，`appendTransaction` 收本地 transaction 的 link `AddMarkStep`（autolink、
 *   連結對話框的 `createLink`、link toolbar 改網址）——掛在 `NoteEditor` 的 `_tiptapOptions.extensions`。貼上（含選取上貼網址、
 *   裸網址的 paste rule）不歸它：一次貼上只由貼上 hook 處理（見 `isForeign`、`pastingRefs`）；拖放也不歸它（#352，見下）。
 * - `createSiteLinkPasteHook`：`createMarkdownPasteHandler` 的掛點——貼上的出口返回後，對前後文件的 diff 範圍呼叫 `convertSiteLinksInRange`。
 * - `withSiteLinkDrop`（#352）：`handleDOMEvents.drop` 的最外層——從編輯器外拖進來的放下，在 microtask 裡對放下範圍呼叫
 *   `convertSiteLinksInRange`。範圍由上面那個外掛在拖放期間記錄（`droppingRefs`、`recordDropRange`）；外掛本身仍不轉拖放的 link。
 * - 非同步後備：快取解析不到的站內網址問 server（A6：每次動作 ≤20 個相異 href、單發 5 s），成功後一筆 transaction 套用。
 * 所有轉換 transaction 帶 meta `knotebook:siteLinkConvert`；外掛看到它或 `y-sync$`（遠端、撤銷／重做）一律跳過。
 */
import { Extension } from "@tiptap/core";
import type { BlockNoteEditor } from "@blocknote/core";
import type { SiteLinkCandidate, SiteLinkTarget, SiteNoteHref } from "@knotebook/shared";
import { FALLBACK_MAX_HREFS, resolveFromCache, resolveViaServer } from "@/lib/site-link-resolve";
import type { EditorRef } from "@/components/wikilink/menu";
import type { PasteConversionHook } from "./paste";
import { createPmPlugin } from "./pm-plugin";
import { addedLinkRanges, blockRanges, collectSiteLinks, replaceSiteLinks, SITE_LINK_CONVERT_META, Y_SYNC_META, type SiteLinkRange } from "./site-link-pm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組／PM 型別在 apps/web 值層級拿不到，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type Any = any;

export interface FallbackRequest {
  blockIds: string[];
  href: string;
  text: string;
  parsed: SiteNoteHref;
}

export interface SiteLinkEnv {
  origin: string;
  /** `["notes"]` 快取（未載入＝undefined）。 */
  notes(): readonly SiteLinkCandidate[] | undefined;
  /** 解析不到（miss／unknown）但是站內網址：排非同步後備。 */
  schedule(requests: FallbackRequest[]): void;
}

export type SiteLinkEnvRef = { current: SiteLinkEnv | null };

function toRequests(links: readonly SiteLinkRange[]): FallbackRequest[] {
  return links.map((l) => ({ blockIds: l.blockId ? [l.blockId] : [], href: l.href, text: l.text, parsed: l.parsed }));
}

/** 同步可解者換掉、其餘排後備；回傳那一筆 tr（沒有東西可換時回 null）。`tr` 必須是全新的（`links` 取自 `tr.doc`）。 */
function convertLinks(tr: Any, links: readonly SiteLinkRange[], env: SiteLinkEnv): Any | null {
  tr.setMeta(SITE_LINK_CONVERT_META, true);
  const left = replaceSiteLinks(tr, links, (link) => {
    const r = resolveFromCache(env.notes(), link.parsed);
    return r.kind === "hit" ? r.target : null;
  });
  if (left.length > 0) {
    const requests = toRequests(left);
    queueMicrotask(() => env.schedule(requests)); // 不在 apply 期間觸發副作用
  }
  return tr.docChanged ? tr : null;
}

/**
 * 不當成本地動作處理的 tr（§8.4）：
 * - `y-sync$`（遠端更新、y-undo 撤銷／重做）、`knotebook:siteLinkConvert`（轉換本身）；
 * - 拖放（drop）：prosemirror-view 的 drop handler 對那筆 tr 設 `uiEvent: "drop"`；外部拖進的純文字網址由 tiptap 的 paste rule
 *   （`pasteRulesPlugin` 對 drop 也跑）在**另一筆附加的** tr 加 link mark。一次拖放只歸 drop hook（`withSiteLinkDrop`，#352）——
 *   外掛也收的話，快取未命中時同一個連結會排兩次後備。
 * - 貼上（`uiEvent: "paste"`，prosemirror-view 的 `doPaste`）：一次貼上只歸一個擁有者——由 `createSiteLinkPasteHook` 對前後 diff
 *   範圍轉換；外掛若也收 paste rule 附加的 link，快取未命中時同一個連結會排兩次後備（A6 上限翻倍、§7.6 撤銷後可能被晚到的第二發轉回）。
 */
function isForeign(tr: Any): boolean {
  const ui = tr.getMeta("uiEvent");
  return tr.getMeta(Y_SYNC_META) !== undefined || tr.getMeta(SITE_LINK_CONVERT_META) !== undefined || ui === "drop" || ui === "paste";
}

/**
 * 別的外掛 `appendTransaction` 附加的 tr，其根 tr 掛在 PM 的 `appendedTransaction` meta 上（每一筆附加 tr 都指向同一個根）。
 * 外掛順序是確定的：BlockNote 把 `_tiptapOptions.extensions` 放在 extension 清單最後，tiptap 先反轉再依 priority 穩定排序，
 * 所以本外掛排在 BlockNote Link 的 paste rule／autolink **之前**——它們附加的 link tr 會在下一輪**單獨**送到本外掛。
 * 因此根 tr 也要看：根是遠端更新（y-sync$，autolink 不跳過它）／轉換本身時，附加上的 link mark 一樣不轉；根是拖放／貼上時
 * 也不由外掛轉——那次動作歸 drop hook／貼上 hook。
 */
function excluded(tr: Any): boolean {
  const root = tr.getMeta("appendedTransaction");
  return isForeign(tr) || (root !== undefined && isForeign(root));
}

export function appendSiteLinkConversion(trs: readonly Any[], state: Any, env: SiteLinkEnv | null): Any | null {
  if (!env) return null;
  if (trs.some(excluded)) return null;
  const ranges = addedLinkRanges(trs);
  if (ranges.length === 0) return null;
  const links = collectSiteLinks(state.doc, ranges, env.origin);
  if (links.length === 0) return null;
  return convertLinks(state.tr, links, env);
}

/**
 * 貼上進行中（`createSiteLinkPasteHook` 的 `before` → `after`）的 envRef：這段期間外掛不收任何 tr，該次貼上一律由 hook 處理。
 * `uiEvent: "paste"` 擋不到「選取上貼網址」：Link 的 `handlePaste` 用 `commands.setMark` 自己 dispatch，那筆 tr 不帶 uiEvent。
 * `after` 沒被呼叫（出口拋錯）時由 microtask 收回——貼上整段是同步的，microtask 一定在它之後。
 */
const pastingRefs = new WeakSet<SiteLinkEnvRef>();

type DropRange = { from: number; to: number };

/**
 * 拖放進行中（`withSiteLinkDrop` 的 before → after）的放下範圍；null＝還沒看到 drop tr、或不轉。
 * 不放 plugin state：plugin state 沒有重設點，下一次沒有 drop tr 的放下（媒體阻擋、Files、只有 uri-list）會讀到上一次的範圍。
 * before 覆寫成 null、after（與 before 的 catch）刪除，兩道互為備援。
 */
const droppingRefs = new WeakMap<SiteLinkEnvRef, DropRange | null>();

/** 外掛 `appendTransaction` 先呼叫：拖放期間記下 drop tr 插入的範圍，並映射過其後的每一筆 tr（paste rule、UniqueID、fixTables…）。 */
function recordDropRange(trs: readonly Any[], envRef: SiteLinkEnvRef): void {
  if (!droppingRefs.has(envRef)) return;
  let r = droppingRefs.get(envRef) ?? null;
  for (const tr of trs) {
    if (tr.getMeta("uiEvent") === "drop") {
      // 同 prosemirror-view handleDrop 算 `end` 的方式：最後一個 step 的 StepMap。不是恰好一段就不轉（往不轉的方向錯）。
      const maps = tr.mapping.maps as readonly Any[];
      const segments: DropRange[] = [];
      maps[maps.length - 1]?.forEach((_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => segments.push({ from: newStart, to: newEnd }));
      r = segments.length === 1 ? segments[0]! : null;
    } else if (r) {
      r = { from: tr.mapping.map(r.from, -1), to: tr.mapping.map(r.to, 1) };
    }
  }
  droppingRefs.set(envRef, r);
}

export function createSiteLinkConvertExtension({ envRef }: { envRef: SiteLinkEnvRef }): Extension {
  return Extension.create({
    name: "knotebookSiteLinkConvert",
    addProseMirrorPlugins() {
      return [
        createPmPlugin({
          appendTransaction: (trs, _old, state) => {
            recordDropRange(trs, envRef);
            return pastingRefs.has(envRef) ? null : appendSiteLinkConversion(trs, state, envRef.current);
          },
        }) as never,
      ];
    },
  });
}

/** 貼上（§8.3）：新文件 `[from, to]` 內的站內連結；同步可解者一筆 transaction 換掉，其餘排後備。整段不拋錯（呼叫端另有 try/catch）。 */
export function convertSiteLinksInRange(editor: AnyEditor, from: number, to: number, env: SiteLinkEnv): void {
  const view = editor._tiptapEditor.view;
  const links = collectSiteLinks(view.state.doc, [{ from, to }], env.origin);
  if (links.length === 0) return;
  const tr = convertLinks(view.state.tr, links, env);
  if (tr) view.dispatch(tr);
}

/**
 * §6.5 後備：相異 href 最多 20 個、各自問 server（逾時 5 s 在 `resolveViaServer` 內）；成功者**一筆** transaction、只在仍存在的
 * `blockIds` 內找「href 與文字都相同」的連結換掉；都找不到（文件已被改）就放棄。回傳換掉的個數。
 */
export async function runFallbackConversion(
  editor: AnyEditor | null,
  requests: readonly FallbackRequest[],
  origin: string,
  resolve: (p: SiteNoteHref) => Promise<SiteLinkTarget | null> = resolveViaServer,
): Promise<number> {
  const byHref = new Map<string, FallbackRequest[]>();
  for (const r of requests) byHref.set(r.href, [...(byHref.get(r.href) ?? []), r]);
  const hrefs = [...byHref.keys()].slice(0, FALLBACK_MAX_HREFS);
  const resolved = new Map<string, SiteLinkTarget>();
  await Promise.all(
    hrefs.map(async (href) => {
      const target = await resolve(byHref.get(href)![0]!.parsed);
      if (target) resolved.set(href, target);
    }),
  );
  // 等 server 的期間編輯器可能已 unmount（換篇）：tiptap unmount 後 `view` 是 stub proxy（`isDestroyed: false`、dispatch 落到脫離的
  // state），不能靠 `view.isDestroyed`。BlockNote 的 `headless` 在 tiptap mount／unmount 事件上同步翻面。
  if (resolved.size === 0 || !editor || editor.headless) return 0;
  const view = editor._tiptapEditor.view;
  const wanted = new Set(requests.filter((r) => resolved.has(r.href)).map((r) => `${r.href}\u0000${r.text}`));
  const blockIds = new Set(requests.flatMap((r) => r.blockIds));
  const links = collectSiteLinks(view.state.doc, blockRanges(view.state.doc, blockIds), origin).filter((l) => wanted.has(`${l.href}\u0000${l.text}`));
  if (links.length === 0) return 0;
  const tr = view.state.tr;
  tr.setMeta(SITE_LINK_CONVERT_META, true);
  replaceSiteLinks(tr, links, (l) => resolved.get(l.href) ?? null);
  view.dispatch(tr);
  return links.length;
}

/**
 * §8.3：貼上前後的文件 diff 範圍（不依 block id——行內貼上不換 block id 也抓得到，補 mermaid 快照法的盲點）。
 * - 重複內容時 `findDiffEnd` 會往前多吃（貼上的內容與相鄰的既有內容相同 ⇒ 結尾的 a 或 b 側退到起點之前），照 ProseMirror
 *   慣例（prosemirror-view 的 `findDiff`）以貼上前的游標 `pref` 消歧：落在重疊區內就把起點退到 `pref`，範圍長度＝新舊大小差。
 *   不消歧的話，在既有同內容的**前方**貼上會轉到既有那份、貼上那份留一般連結。
 * - 正規化成 `from ≤ to`；只剩刪除（`from === to`）就不轉：新文件裡沒有新內容，而 `collectSiteLinks` 的點範圍含端點，
 *   交進去會把緊鄰的既有站內連結收進來。
 */
export function createSiteLinkPasteHook(envRef: SiteLinkEnvRef): PasteConversionHook {
  return {
    before: (editor) => {
      const state = (editor as AnyEditor)._tiptapEditor.view.state;
      pastingRefs.add(envRef);
      queueMicrotask(() => pastingRefs.delete(envRef));
      return { doc: state.doc, pref: state.selection.from as number };
    },
    after: (editor, snapshot) => {
      pastingRefs.delete(envRef);
      const env = envRef.current;
      if (!env) return;
      const ed = editor as AnyEditor;
      const { doc: before, pref } = snapshot as { doc: Any; pref: number };
      const after = ed._tiptapEditor.view.state.doc;
      let start: number | null = before.content.findDiffStart(after.content);
      if (start === null || start === undefined) return;
      const end: { a: number; b: number } | null = before.content.findDiffEnd(after.content);
      let endB = end ? end.b : after.content.size;
      const endA = end ? end.a : before.content.size;
      // 同 prosemirror-view `findDiff` 的兩個分支（只取本處用得到的 endB；`endA` 之後不再用）
      if (endA < start && before.content.size < after.content.size) {
        start -= pref <= start && pref >= endA ? start - pref : 0;
        endB = start + (endB - endA);
      } else if (endB < start) {
        start -= pref <= start && pref >= endB ? start - pref : 0;
        endB = start;
      }
      const from = Math.min(start, endB);
      const to = Math.max(start, endB);
      if (from === to) return;
      convertSiteLinksInRange(ed, from, to, env);
    },
  };
}

function afterDrop(envRef: SiteLinkEnvRef, editorRef: EditorRef): void {
  let range: DropRange | null | undefined;
  try {
    range = droppingRefs.get(envRef);
  } finally {
    droppingRefs.delete(envRef);
  }
  // 沒看到 drop tr（null）不轉；映射後成為空範圍也不轉——`collectSiteLinks` 的點範圍含端點，會把緊鄰的既有連結收進來。
  if (!range || range.from >= range.to) return;
  try {
    const env = envRef.current;
    const editor = editorRef.current;
    // 同 `runFallbackConversion`：編輯器已 unmount 時 `view` 是 stub，靠 `headless` 判斷。
    if (env && editor && !editor.headless) convertSiteLinksInRange(editor, range.from, range.to, env);
  } catch (err) {
    console.warn("[site-link] drop conversion failed", err);
  }
}

/**
 * #352：`handleDOMEvents.drop` 的最外層。從編輯器外拖進來（可編輯、env 在、`view.dragging` 為 null）時，同步啟用記錄
 * （設成 null）並排一個 microtask；PM 的 drop tr 與各外掛附加的 tr 都在這個 listener 內同步跑完，microtask 才讀範圍、轉換。
 * 前提：兩次放下之間一定有 microtask checkpoint（每個 listener 回呼結束都會清）。內部拖曳（有 `dragging`）不轉。
 * 一律回傳內層的結果；自己的判斷拋錯不擋內層。
 */
export function withSiteLinkDrop<T extends { drop: (view: unknown, event: DragEvent) => boolean }>(envRef: SiteLinkEnvRef, editorRef: EditorRef, inner: T): T {
  return {
    ...inner,
    drop: (view: unknown, event: DragEvent) => {
      try {
        const v = view as { editable?: unknown; dragging?: unknown } | null;
        if (v?.editable && envRef.current && v.dragging == null) {
          droppingRefs.set(envRef, null);
          queueMicrotask(() => afterDrop(envRef, editorRef));
        }
      } catch {
        droppingRefs.delete(envRef);
      }
      return inner.drop(view, event);
    },
  };
}

export function createSiteLinkEnv(opts: { origin: string; getNotes(): readonly SiteLinkCandidate[] | undefined; editorRef: { current: AnyEditor | null } }): SiteLinkEnv {
  return {
    origin: opts.origin,
    notes: opts.getNotes,
    // 後備失敗只放棄轉換（維持一般連結），不變成 unhandled rejection。
    schedule: (requests) =>
      void runFallbackConversion(opts.editorRef.current, requests, opts.origin).catch((err: unknown) => console.warn("[site-link] fallback conversion failed", err)),
  };
}
