import type * as Y from "yjs";
import type { QueryClient } from "@tanstack/react-query";
import Reveal from "reveal.js";
import type { RevealApi } from "reveal.js";
import { canonicalNotePath, YDOC_FRAGMENT, type NoteDto } from "@knotebook/shared";
import { safeMediaUrl } from "@/lib/media-url";
import { sameNoteId } from "@/lib/note-id";
import { publicMediaUrl } from "@/lib/public-media-url";
import type { PublicNoteRef } from "@/lib/public-note-ref";
import type { PresentationShellContextValue } from "./PresentationShell";
import { restackSlideBody } from "./columns";
import { createDebouncer } from "./debounce";
import { applyRenderedDeck, createDeckDom, playingMedia, SLIDE_ID_ATTR, watchSwipeGuards, withoutTransition, type SwipeGuards } from "./deck";
import type { HashWriter } from "./hash-writer";
import {
  codeHighlightJobsIn, mathJobsIn, mermaidJobsIn, runCodeHighlightJob, runMathJob, runMermaidJob,
  type CodeHighlightJob, type MathJob, type MermaidJob, type PostprocessContext,
} from "./postprocess";
import { PRESENT_SEARCH, slideIdFromHash } from "./present-url";
import { createExportEditor, renderDeck, type ExportEditor } from "./render";
import { locateSlide, repositionAfterUpdate } from "./reposition";
import { buildRevealConfig, configMatches, htmlHasPrintClasses, type RevealKeyHandlers } from "./reveal-config";
import { COVER_ID } from "./slides";

/**
 * StrictMode safe: each startDeck builds its own `div.reveal > div.slides`. Never destroy before initialize's Promise
 * resolves (it would never resolve and the listeners could not be removed): if already disposed by then, tear down then;
 * only the one that sent onRevealReady(true) sends false (reveal's isReady() fires one tick before the Promise, so it is
 * not used). The initial build is queued in queueMicrotask (the export must not run in an effect body); StrictMode's first
 * copy is disposed before the microtask, so it never does `new Reveal`.
 * reveal merges the URL query into its config: `?present` is asserted before init and every getConfig() key (and the
 * <html> classes, on the next rAF) re-checked after; a mismatch → shell.onFatal("present.configRefused").
 * Positioning reads the router hash `#/<id>`: reveal's own readURL matches no slide because slides have no id / data-id.
 * Updates never rebuild reveal, so fullscreen is unaffected; media paused by reveal resumes when the current slide's content is unchanged.
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
  hash: string;
}

export interface DeckController {
  sourceChanged(): void;
  themeChanged(): void;
  dispose(): void;
}

interface KeyTargetBox {
  current: { reveal: () => RevealApi | null; shell: () => PresentationShellContextValue } | null;
}

/**
 * reveal 6.0.2's setupScrollPrevention (js/reveal.js:459-467) creates a 1 s setInterval whose id is not stored and which
 * destroy() does not clear; its closure keeps that instance's config, and with it our keyboard handlers, alive. A handler
 * created inside startDeck would share V8's closure context and keep the whole startDeck scope (slide DOM, export editor,
 * Y.Doc) alive too. Mitigation: handlers are created here and capture only a box emptied at teardown (which also clears the
 * slide DOM and references). Only a mitigation: each presentation still leaves reveal's empty shell and an empty box.
 * When upgrading reveal, re-check whether destroy() clears this interval.
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
  const codeHighlightGeneration = new WeakMap<Element, number>();

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
          const note = notes.find((candidate) => sameNoteId(candidate.id, targetNoteId));
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

  const runMath = (jobs: readonly MathJob[]) => {
    for (const job of jobs) {
      // No per-element generation (unlike mermaid): math runs once per element, never again on the same one (a theme switch does
      // not redraw it and a changed slide gets fresh elements), and a replaced element is no longer connected.
      void runMathJob(
        job,
        () => !destroyed && !disposed && job.el.isConnected,
        env().t("note.math.sourceFallback"),
      ).then((applied) => {
        if (applied) swipe?.refresh(job.el);
      });
    }
  };

  const runCodeHighlight = (jobs: readonly CodeHighlightJob[]) => {
    for (const job of jobs) {
      const generation = (codeHighlightGeneration.get(job.el) ?? 0) + 1;
      codeHighlightGeneration.set(job.el, generation);
      void runCodeHighlightJob(
        job,
        () => !destroyed && !disposed && job.el.isConnected && codeHighlightGeneration.get(job.el) === generation,
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
    const playing = oldEls && !currentRebuilt ? playingMedia(oldEls.section) : [];
    const { structureChanged, changed } = applyRenderedDeck(dom, rendered);
    if (!structureChanged && changed.length === 0) return;
    const position = repositionAfterUpdate(oldSections, oldCurrent, dom.sections);
    withoutTransition(dom.revealEl, () => {
      if (structureChanged) deck.sync();
      else for (const id of changed) deck.syncSlide(dom.els.get(id)!.section);
      deck.slide(position.h, position.v);
    });
    for (const id of changed) restackSlideBody(dom.els.get(id)!.body); // column stacking: slides too far from the current one measure 0 and are left alone; onSlideChanged fills them in when they become current
    for (const media of playing) if (media.isConnected && media.paused) void media.play().catch(() => {});
    currentId = position.id;
    hashWriter.request(position.id);
    if (currentRebuilt && position.id === oldCurrent) dom.els.get(oldCurrent)!.section.scrollTop = 0;
    for (const id of changed) {
      const els = dom.els.get(id)!;
      swipe?.observe(els);
      runMermaid(mermaidJobsIn(els.body));
      runMath(mathJobsIn(els.body));
      runCodeHighlight(codeHighlightJobsIn(els.body));
    }
    swipe?.refreshAll();
  };

  const applyUpdate = () => {
    if (!live()) return;
    try {
      applyUpdateNow();
    } catch (err) {
      console.error(err);
      // The export runs outside React, so an error boundary cannot catch it: the shell shows an error and unmounts the overlay → teardown.
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
    const body = dom.els.get(id)?.body;
    if (body) restackSlideBody(body);
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
    if (!resolved || destroyed) return; // never destroy before resolve
    destroyed = true;
    debouncer.cancel();
    unsubscribeSource?.();
    swipe?.disconnect();
    reveal?.off("slidechanged", onSlideChanged);
    reveal?.destroy();
    dom.revealEl.remove();
    // Mitigation for the interval leak (see createKeyHandlers).
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
      env().shell.onFatal("present.configRefused");
      return;
    }
    try {
      build();
    } catch (err) {
      console.error(err);
      // Same exit as above; reveal never resolved, so it is not destroyed.
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
          env().shell.onFatal("present.configRefused"); // the shell unmounts the overlay → dispose → teardown
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
          // Not found → back to the cover: during initialization reveal's readURL() treats a numeric hash (#/1, #/2/0) as an index and
          // jumps to that slide (location.js:76-90). If this changes the index reveal sends slidechanged and onSlideChanged writes
          // #/_title; already at (0,0) no event is sent and the URL stays.
          instance.slide(0, 0);
        }
        swipe.refreshAll();
        // reveal makes only the present slide and its neighbours (viewDistance) visible during initialize(), so earlier measurements are 0;
        // only those can be measured here, the rest are measured by onSlideChanged when they become current.
        for (const els of dom.els.values()) restackSlideBody(els.body);
        runMermaid(mermaidJobsIn(dom.slidesEl));
        runMath(mathJobsIn(dom.slidesEl));
        runCodeHighlight(codeHighlightJobsIn(dom.slidesEl));
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
        if (!disposed) env().shell.onFatal("app.noteCrash");
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
