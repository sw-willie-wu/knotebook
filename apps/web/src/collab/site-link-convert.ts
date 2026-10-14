/**
 * #269 §8.4／§6.5：client 寫入路徑的站內連結轉換。
 * - `createSiteLinkConvertExtension`：tiptap extension，`appendTransaction` 收本地 transaction 的 link `AddMarkStep`（autolink、
 *   連結對話框的 `createLink`、選取上貼網址、link toolbar 改網址）——掛在 `NoteEditor` 的 `_tiptapOptions.extensions`。
 * - `convertSiteLinksInRange`：貼上（Task 12）在出口返回後對 diff 範圍呼叫。
 * - 非同步後備：快取解析不到的站內網址問 server（A6：每次動作 ≤20 個相異 href、單發 5 s），成功後一筆 transaction 套用。
 * 所有轉換 transaction 帶 meta `knotebook:siteLinkConvert`；外掛看到它或 `y-sync$`（遠端、撤銷／重做）一律跳過。
 */
import { Extension } from "@tiptap/core";
import type { BlockNoteEditor } from "@blocknote/core";
import type { SiteLinkCandidate, SiteLinkTarget, SiteNoteHref } from "@knotebook/shared";
import { FALLBACK_MAX_HREFS, resolveFromCache, resolveViaServer } from "@/lib/site-link-resolve";
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
 * 不當成本地動作處理的 tr（§8.4、§1.3／§17-4）：
 * - `y-sync$`（遠端更新、y-undo 撤銷／重做）、`knotebook:siteLinkConvert`（轉換本身）；
 * - 拖放（drop）：prosemirror-view 的 drop handler 對那筆 tr 設 `uiEvent: "drop"`；外部拖進的純文字網址由 tiptap 的 paste rule
 *   （`pasteRulesPlugin` 對 drop 也跑）在**另一筆附加的** tr 加 link mark。
 */
function isForeign(tr: Any): boolean {
  return tr.getMeta(Y_SYNC_META) !== undefined || tr.getMeta(SITE_LINK_CONVERT_META) !== undefined || tr.getMeta("uiEvent") === "drop";
}

/**
 * 別的外掛 `appendTransaction` 附加的 tr，其根 tr 掛在 PM 的 `appendedTransaction` meta 上。外掛順序不定（附加 tr 可能在下一輪才
 * 單獨送到本外掛），所以根 tr 也要看：根是遠端更新／轉換本身／拖放時，附加上的 link mark 一樣不轉。
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

export function createSiteLinkConvertExtension({ envRef }: { envRef: SiteLinkEnvRef }): Extension {
  return Extension.create({
    name: "knotebookSiteLinkConvert",
    addProseMirrorPlugins() {
      return [createPmPlugin({ appendTransaction: (trs, _old, state) => appendSiteLinkConversion(trs, state, envRef.current) }) as never];
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

export function createSiteLinkEnv(opts: { origin: string; getNotes(): readonly SiteLinkCandidate[] | undefined; editorRef: { current: AnyEditor | null } }): SiteLinkEnv {
  return {
    origin: opts.origin,
    notes: opts.getNotes,
    // 後備失敗只放棄轉換（維持一般連結），不變成 unhandled rejection。
    schedule: (requests) =>
      void runFallbackConversion(opts.editorRef.current, requests, opts.origin).catch((err: unknown) => console.warn("[site-link] fallback conversion failed", err)),
  };
}
