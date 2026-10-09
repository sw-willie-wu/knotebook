import type * as Y from "yjs";
import type { QueryClient } from "@tanstack/react-query";
import Reveal from "reveal.js";
import type { RevealApi } from "reveal.js";
import { canonicalNotePath, YDOC_FRAGMENT, type NoteDto } from "@knotebook/shared";
import { safeMediaUrl } from "@/lib/media-url";
import { publicMediaUrl } from "@/lib/public-media-url";
import type { PublicNoteRef } from "@/lib/public-note-ref";
import type { PresentationShellContextValue } from "./PresentationShell";
import { createDebouncer } from "./debounce";
import { applyRenderedDeck, createDeckDom, playingMedia, SLIDE_ID_ATTR, watchSwipeGuards, withoutTransition, type SwipeGuards } from "./deck";
import type { HashWriter } from "./hash-writer";
import { mermaidJobsIn, runMermaidJob, type MermaidJob, type PostprocessContext } from "./postprocess";
import { PRESENT_SEARCH, slideIdFromHash } from "./present-url";
import { createExportEditor, renderDeck, type ExportEditor } from "./render";
import { locateSlide, repositionAfterUpdate } from "./reposition";
import { buildRevealConfig, configMatches, htmlHasPrintClasses, type RevealKeyHandlers } from "./reveal-config";
import { COVER_ID } from "./slides";

/**
 * #229 reveal 的生命週期（spec §6.9）與即時更新（§7、§8）——React 只負責呼叫 startDeck／dispose。
 *
 * 生命週期（StrictMode 安全）：每次 startDeck 自建 `div.reveal > div.slides`；三個旗標 resolved／disposed／destroyed
 * 外加 announced。**Promise resolve 之前絕不 destroy**（§2.11-14：會讓 initialize 永不 resolve、監聽拆不掉）——
 * resolve 時若已 disposed 才拆；只有送過 onRevealReady(true) 的這份才送 false。不用 reveal 的 isReady()（比 Promise 早一拍）。
 * 初始建置排在 queueMicrotask（§5.1-6：匯出不得在 effect 本體）；StrictMode 的第一份在 microtask 前已 disposed，
 * 根本不會 new Reveal（起草裁定 11）。
 *
 * 初始化前斷言 `window.location.search === "?present"`（§6.4-1）、初始化後 getConfig() 逐鍵核對＋下一個 rAF 補查
 * <html> class（§6.4-3）；任一不符 → shell.onFatal("present.configRefused")，外殼卸載 overlay、cleanup 走拆除。
 * 定位（§6.4-4）：讀 router hash `#/<id>` → 找到就 slide(h, v)，否則封面；reveal 自己的 readURL 因 A11 不會命中任何投影片。
 *
 * 更新（§7.1）：已登入＝fragment.observeDeep；公開＝doc prop 換成新的 Y.Doc（F1）；兩者另加 title 變動。防抖 500 ms／2 s
 * → 在 timer callback 重切、逐張比對（同 id 沿用元素）→ 結構變了 sync()、只有內容變 syncSlide()；以 repositionAfterUpdate
 * 算位置、無轉場套用；目前那張內容沒變時恢復被 reveal 暫停的媒體；目前那張內容變了才捲回頂端（F4）。不重建 reveal、
 * 全螢幕不受影響。
 */
export type PresentationSource =
  | { variant: "member"; doc: Y.Doc; title: string }
  | { variant: "public"; doc: Y.Doc; title: string; publicRef: PublicNoteRef };

export interface DeckEnv {
  source: PresentationSource;
  shell: PresentationShellContextValue;
  theme: "light" | "dark";
  t: (key: string) => string;
  queryClient: QueryClient;
  /** router 的 location.hash（初始化定位用）。 */
  hash: string;
}

export interface DeckController {
  /** doc 或 title prop 變了（React effect 呼叫）。 */
  sourceChanged(): void;
  themeChanged(): void;
  dispose(): void;
}

/** keyboard handler 經由它找到「這一次」的 reveal 與外殼；teardown 時清成 null。 */
interface KeyTargetBox {
  current: { reveal: () => RevealApi | null; shell: () => PresentationShellContextValue } | null;
}

/**
 * reveal 6.0.2 的 setupScrollPrevention（js/reveal.js:459-467）建的 1 s setInterval 沒存 id、destroy() 也不清，
 * 它的閉包會一直留住該實例的 config，連帶留住我們傳進去的 keyboard handler。handler 若在 startDeck 裡建，V8 共用
 * 閉包 context 會把 startDeck 整個作用域（投影片 DOM、匯出 editor、env → Y.Doc）一起留住。緩解做法：handler 在這裡
 * （startDeck 作用域外）建，只捕獲一個 teardown 時清空的 box；teardown 另清投影片 DOM 與各參照。不攔截全域 setInterval。
 * 這是緩解、不是根治——每次簡報仍會留下 reveal 自己的空殼與一個空 box。升 reveal 版本時重新確認 destroy() 是否已清這支 interval。
 */
function createKeyHandlers(box: KeyTargetBox): RevealKeyHandlers {
  return {
    onEsc: () => {
      const target = box.current;
      if (!target) return;
      const deck = target.reveal();
      if (deck?.isOverview()) {
        deck.toggleOverview(false);
        return;
      }
      target.shell().onEsc();
    },
    onF: () => box.current?.shell().toggleFullscreen(),
    onO: () => box.current?.reveal()?.toggleOverview(),
  };
}

export function startDeck(host: HTMLElement, env: () => DeckEnv, hashWriter: HashWriter): DeckController {
  let disposed = false;
  let resolved = false;
  let destroyed = false;
  let announced = false;
  let pendingSourceChange = false;
  let reveal: RevealApi | null = null;
  let editor: ExportEditor | null = null;
  let swipe: SwipeGuards | null = null;
  let unsubscribeSource: (() => void) | null = null;
  let lastSource: { doc: Y.Doc; title: string } | null = null;
  let currentId = COVER_ID;
  const dom = createDeckDom();
  const mermaidGeneration = new WeakMap<Element, number>();

  const live = () => resolved && !destroyed && !disposed && reveal !== null && editor !== null;

  const postprocessContext = (): PostprocessContext => {
    const { source, queryClient } = env();
    if (source.variant === "public") return { resolveMedia: publicMediaUrl(source.publicRef), wikilinks: { kind: "public" } };
    return {
      resolveMedia: (url) => safeMediaUrl(url),
      wikilinks: {
        kind: "member",
        brokenLabel: env().t("note.wikilinkBroken"),
        resolve: (targetNoteId) => {
          const notes = queryClient.getQueryData<NoteDto[]>(["notes"]);
          if (!notes) return { kind: "pending" };
          const note = notes.find((candidate) => candidate.id === targetNoteId);
          return note ? { kind: "found", href: canonicalNotePath(note), title: note.title } : { kind: "broken" };
        },
      },
    };
  };

  const runMermaid = (jobs: readonly MermaidJob[]) => {
    for (const job of jobs) {
      const generation = (mermaidGeneration.get(job.el) ?? 0) + 1;
      mermaidGeneration.set(job.el, generation);
      const { theme, t } = env();
      void runMermaidJob(
        job,
        theme,
        () => !destroyed && !disposed && job.el.isConnected && mermaidGeneration.get(job.el) === generation,
        t("present.mermaidError"),
      ).then((applied) => {
        if (applied) swipe?.refresh(job.el);
      });
    }
  };

  const render = (previousKeys?: ReadonlyMap<string, string>) => {
    const { source, t } = env();
    lastSource = { doc: source.doc, title: source.title };
    return renderDeck({
      editor: editor!,
      doc: source.doc,
      title: source.title,
      titlePlaceholder: t("note.titlePlaceholder"),
      ctx: postprocessContext(),
      previousKeys,
    });
  };

  const applyUpdateNow = () => {
    const deck = reveal!;
    const oldSections = dom.sections;
    const oldCurrent = currentId;
    const rendered = render(dom.keys);
    const currentRebuilt = rendered.some((section) => section.slides.some((slide) => slide.id === oldCurrent && slide.content !== null));
    const oldEls = dom.els.get(oldCurrent);
    const playing = oldEls && !currentRebuilt ? playingMedia(oldEls.section) : []; // S5
    const { structureChanged, changed } = applyRenderedDeck(dom, rendered);
    if (!structureChanged && changed.length === 0) return;
    const position = repositionAfterUpdate(oldSections, oldCurrent, dom.sections);
    withoutTransition(dom.revealEl, () => {
      if (structureChanged) deck.sync();
      else for (const id of changed) deck.syncSlide(dom.els.get(id)!.section);
      deck.slide(position.h, position.v);
    });
    for (const media of playing) if (media.isConnected && media.paused) void media.play().catch(() => {}); // S5
    currentId = position.id;
    hashWriter.request(position.id);
    if (currentRebuilt && position.id === oldCurrent) dom.els.get(oldCurrent)!.section.scrollTop = 0; // F4
    for (const id of changed) {
      const els = dom.els.get(id)!;
      swipe?.observe(els);
      runMermaid(mermaidJobsIn(els.body));
    }
    swipe?.refreshAll();
  };

  const applyUpdate = () => {
    if (!live()) return;
    try {
      applyUpdateNow();
    } catch (err) {
      console.error(err);
      // 匯出在 React 之外（§5.1-6），錯誤邊界接不到——同起草裁定 6 的出口：外殼顯示錯誤、卸載 overlay → teardown。
      env().shell.onFatal("app.noteCrash");
    }
  };

  const debouncer = createDebouncer(applyUpdate);

  const onSlideChanged = (event: Event) => {
    const slide = (event as Event & { currentSlide?: Element | null }).currentSlide ?? null;
    const id = slide?.getAttribute(SLIDE_ID_ATTR);
    if (!id) return;
    currentId = id;
    hashWriter.request(id);
    swipe?.refresh(slide);
  };

  const subscribeSource = (): (() => void) | null => {
    const { source } = env();
    if (source.variant !== "member") return null;
    const fragment = source.doc.getXmlFragment(YDOC_FRAGMENT);
    const onChange = () => debouncer.schedule();
    fragment.observeDeep(onChange);
    return () => fragment.unobserveDeep(onChange);
  };

  const teardown = () => {
    if (!resolved || destroyed) return; // §6.9：resolve 之前絕不 destroy
    destroyed = true;
    debouncer.cancel();
    unsubscribeSource?.();
    swipe?.disconnect();
    reveal?.off("slidechanged", onSlideChanged);
    reveal?.destroy();
    dom.revealEl.remove();
    // interval 洩漏的緩解（見 createKeyHandlers）：切斷 handler → 本作用域，清掉投影片內容與各參照。
    keyTarget.current = null;
    for (const els of dom.els.values()) els.body.replaceChildren();
    dom.slidesEl.replaceChildren();
    dom.els.clear();
    dom.keys.clear();
    dom.sections = [];
    reveal = null;
    editor = null;
    swipe = null;
    unsubscribeSource = null;
    lastSource = null;
    if (announced) {
      announced = false;
      env().shell.onRevealReady(false);
    }
  };

  const keyTarget: KeyTargetBox = { current: { reveal: () => reveal, shell: () => env().shell } };

  queueMicrotask(() => {
    if (disposed) return;
    if (window.location.search !== PRESENT_SEARCH) {
      env().shell.onFatal("present.configRefused"); // §6.4-1
      return;
    }
    try {
      build();
    } catch (err) {
      console.error(err);
      // 匯出在 React 之外（§5.1-6），錯誤邊界接不到——同起草裁定 6 的出口。reveal 沒有 resolve 過，不 destroy（§6.9）。
      keyTarget.current = null;
      dom.revealEl.remove();
      env().shell.onFatal("app.noteCrash");
    }
  });

  function build() {
    editor = createExportEditor();
    applyRenderedDeck(dom, render());
    host.append(dom.revealEl);
    const config = buildRevealConfig(createKeyHandlers(keyTarget));
    const instance = new Reveal(dom.revealEl, config);
    reveal = instance;
    instance
      .initialize()
      .then(() => {
        resolved = true;
        if (disposed) {
          teardown();
          return;
        }
        if (!configMatches(instance.getConfig(), config)) {
          env().shell.onFatal("present.configRefused"); // §6.4-3：外殼卸載 overlay → dispose → teardown
          return;
        }
        instance.on("slidechanged", onSlideChanged);
        swipe = watchSwipeGuards(dom.slidesEl);
        for (const els of dom.els.values()) swipe.observe(els);
        const target = slideIdFromHash(env().hash);
        const position = target === null ? null : locateSlide(dom.sections, target);
        if (position && target !== null) {
          instance.slide(position.h, position.v);
          currentId = target;
        } else {
          // §6.4-4「否則封面」：reveal 初始化時的 readURL() 會把數字形 hash（#/1、#/2/0）當索引直接跳頁
          // （location.js:76-90，gate r1-p2 M2 實跑）——找不到我們的 id 就明確回封面。若因此改了索引，reveal 送
          // slidechanged、由 onSlideChanged 寫成 #/_title；本來就在 (0,0) 時不送事件、網址不動（起草裁定 7）。
          instance.slide(0, 0);
        }
        swipe.refreshAll();
        runMermaid(mermaidJobsIn(dom.slidesEl));
        unsubscribeSource = subscribeSource();
        requestAnimationFrame(() => {
          if (!destroyed && !disposed && htmlHasPrintClasses()) env().shell.onFatal("present.configRefused");
        });
        announced = true;
        env().shell.onRevealReady(true);
        if (pendingSourceChange) {
          pendingSourceChange = false;
          const { source } = env();
          if (lastSource && (lastSource.doc !== source.doc || lastSource.title !== source.title)) debouncer.schedule();
        }
      })
      .catch((err: unknown) => {
        console.error(err);
        resolved = true;
        if (!disposed) env().shell.onFatal("app.noteCrash"); // 起草裁定 6
      });
  }

  return {
    sourceChanged() {
      const { source } = env();
      if (lastSource && lastSource.doc === source.doc && lastSource.title === source.title) return;
      if (!live()) {
        pendingSourceChange = true;
        return;
      }
      debouncer.schedule();
    },
    themeChanged() {
      if (live()) runMermaid(mermaidJobsIn(dom.slidesEl));
    },
    dispose() {
      disposed = true;
      teardown();
    },
  };
}
