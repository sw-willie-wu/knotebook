import type { AiActionDto } from "@knotebook/shared";
import type { TFunction } from "i18next";
import "@/i18n/tour-strings";
import { showCornerStackForNow } from "@/components/corner-stack-state";
import { isMacPlatform } from "@/lib/platform";
import { getShellControls, getTourNoteEditor } from "@/lib/tour-bridge";
import { findDrawerButton, findTourTarget, findUserMenuTrigger, tourLayout, type TourLayout } from "@/lib/tour-find";
import {
  findInSampleEditor,
  liveSelectionTarget,
  liveTriggerTarget,
  startLiveSelection,
  startLiveTrigger,
  stopLiveSelection,
  stopLiveTrigger,
} from "./live-stops";

/**
 * Targets are found by the `data-kb-tour-target` attribute (`lib/tour-targets.ts`), never by name: the sidebar is full of user-chosen names. The DOM is re-queried every time: AppShell swaps shell between home and note page, so earlier elements may be unmounted.
 * Three layouts (`tourLayout` in `lib/tour-find.ts`) have their own targets and text:
 * - Floating sidebar (640–1279): the sidebar is in a drawer, which is modal (locks focus, marks the outside `aria-hidden`), so the card would be unreachable; sidebar steps point at the header's sidebar button (`narrowTarget`, `narrowBodyKey`) and skip `prepare` (switching tab would open the drawer).
 * - Phone (< 640): list and note are two screens. Steps with `phoneScreen: "list"` return to the list first; the engine calls `StopContext.showScreen` before entering. Add-note and search are round buttons at the bottom, version history is in ⋮ (`phoneTarget`, `phoneBodyKey`, `phoneTitleKey`).
 *   Steps with nothing on phones (the floating format toolbar) are skipped at once without waiting for a target (`skipOnPhone`). There is no drawer there, so `prepare` runs.
 */

export type TourScreen = "list" | "note";

export type StopId = "tabs" | "newNote" | "folders" | "search" | "header" | "versions" | "knowledge" | "tags" | "wikilink" | "ai" | "slash" | "userMenu";

export interface StopContext {
  searchQuery: string;
  /** Not read from the query cache: opening from home it has no data yet, and a cached read would misjudge a configured AI as absent. */
  aiActions: readonly AiActionDto[];
  sampleNoteId: string;
  liveStops: boolean;
  /** Called by the engine before `prepare`; resolves when the screen appeared (or after waiting too long), at once if already there; not provided (unit tests) = no screen change. */
  showScreen?: (screen: TourScreen, signal: AbortSignal) => Promise<void>;
}

export interface StopDef {
  id: StopId;
  titleKey: string;
  bodyKey: string;
  narrowBodyKey?: string;
  phoneTitleKey?: string;
  /** Phone text; falls back to `bodyKey`, deliberately not `narrowBodyKey` (that text is about the drawer). */
  phoneBodyKey?: string;
  target: (ctx: StopContext) => Element[];
  narrowTarget?: (ctx: StopContext) => Element[];
  /** Phone element; falls back to `target`, deliberately not `narrowTarget` (phones have no sidebar button). */
  phoneTarget?: (ctx: StopContext) => Element[];
  skipOnPhone?: boolean;
  phoneScreen?: "list";
  prepare?: (ctx: StopContext) => void;
  precondition?: (ctx: StopContext) => boolean;
  /** Called exactly once after the engine starts entering the step (next, back, skipped, ended, unmount, leaving the sample note), including when `prepare` didn't run (floating sidebar), so it must be safe then. A throw is only logged and doesn't block step changes. */
  leave?: (ctx: StopContext) => void;
  live?: (ctx: StopContext) => boolean;
  /** Run `prepare` with a floating sidebar too (default: skipped, since switching tab opens the drawer); demo steps work in the editor and don't touch the sidebar. */
  prepareInNarrow?: boolean;
}

/** Found only if all are found: highlighting part would mismatch the text. */
function all(...els: (Element | null)[]): Element[] {
  return els.every((el) => el !== null) ? (els as Element[]) : [];
}

const drawerButton = () => all(findDrawerButton());
const noteMenu = () => findTourTarget("noteMenu");

/** Scrolled to once per visit: the target is re-queried every frame, so within a visit the user's own scrolling must win; cleared on leave because later stops (the `[[` demo) scroll the note away. */
let scrolledKnowledgeIcon: Element | null = null;

function sampleKnowledgeIcon(): Element[] {
  const icon = findTourTarget("knowledgeIcon");
  if (icon === null) return [];
  if (scrolledKnowledgeIcon !== icon) {
    scrolledKnowledgeIcon = icon;
    if (typeof icon.scrollIntoView === "function") icon.scrollIntoView({ block: "center" });
  }
  return [icon];
}

/** While searching, the sidebar's tab row and header aren't rendered; the user's query isn't cleared for them, so the step is skipped (blank counts as searching). */
const searchIsEmpty = (ctx: StopContext) => ctx.searchQuery === "";

/** New note exists only on the My notes/Recent tabs and New folder on the My notes header; select mode replaces both, so selection ends too. */
function showMyNotes(): void {
  const shell = getShellControls();
  // Only switch tab: on phones the default brings the screen back to the list (possibly as a Back), which the tour would count as leaving; the tour changes screens itself.
  shell?.showTab("myNotes", { reveal: false });
  shell?.endSelectionIfActive();
}

export const STOPS: Readonly<Record<StopId, StopDef>> = {
  tabs: {
    id: "tabs",
    titleKey: "tourGuide.stops.tabs.title",
    bodyKey: "tourGuide.stops.tabs.body",
    narrowBodyKey: "tourGuide.stops.tabs.narrowBody",
    phoneTitleKey: "tourGuide.stops.tabs.phoneTitle",
    phoneBodyKey: "tourGuide.stops.tabs.phoneBody",
    target: () => all(findTourTarget("tabs")),
    narrowTarget: drawerButton,
    phoneScreen: "list",
    precondition: searchIsEmpty,
  },
  newNote: {
    id: "newNote",
    titleKey: "tourGuide.stops.newNote.title",
    bodyKey: "tourGuide.stops.newNote.body",
    narrowBodyKey: "tourGuide.stops.newNote.narrowBody",
    phoneBodyKey: "tourGuide.stops.newNote.phoneBody",
    target: () => all(findTourTarget("newNote")),
    narrowTarget: drawerButton,
    // Round button at the bottom right of the list (the trash tab has none; `prepare` switches to My notes first).
    phoneTarget: () => all(findTourTarget("phoneNewNote")),
    phoneScreen: "list",
    prepare: showMyNotes,
  },
  folders: {
    id: "folders",
    titleKey: "tourGuide.stops.folders.title",
    bodyKey: "tourGuide.stops.folders.body",
    narrowBodyKey: "tourGuide.stops.folders.narrowBody",
    phoneBodyKey: "tourGuide.stops.folders.phoneBody",
    target: () => all(findTourTarget("newFolder")),
    narrowTarget: drawerButton,
    phoneScreen: "list",
    prepare: showMyNotes,
    precondition: searchIsEmpty,
  },
  search: {
    id: "search",
    titleKey: "tourGuide.stops.search.title",
    bodyKey: "tourGuide.stops.search.body",
    narrowBodyKey: "tourGuide.stops.search.narrowBody",
    phoneBodyKey: "tourGuide.stops.search.phoneBody",
    target: () => all(findTourTarget("search")),
    narrowTarget: drawerButton,
    // Round button at the bottom left of the list; absent in select mode, which the earlier steps' `prepare` already ended.
    phoneTarget: () => all(findTourTarget("phoneSearch")),
    phoneScreen: "list",
    precondition: searchIsEmpty,
  },
  header: {
    id: "header",
    titleKey: "tourGuide.stops.header.title",
    bodyKey: "tourGuide.stops.header.body",
    // Phone ⋮ has no "width" (notes are always full width), so the text doesn't mention it.
    phoneBodyKey: "tourGuide.stops.header.phoneBody",
    target: () => {
      const base = all(findTourTarget("share"), noteMenu());
      if (base.length === 0) return base;
      // Width button between share and ⋮: shown only when the header is wide enough (container query); collapsed it is display:none with no size, so only share and ⋮ are highlighted (width moves into ⋮).
      const width = findTourTarget("noteWidth");
      const rect = width?.getBoundingClientRect();
      return width && rect !== undefined && rect.width > 0 && rect.height > 0 ? [base[0]!, width, base[1]!] : base;
    },
  },
  versions: {
    id: "versions",
    titleKey: "tourGuide.stops.versions.title",
    bodyKey: "tourGuide.stops.versions.body",
    phoneBodyKey: "tourGuide.stops.versions.phoneBody",
    // The bottom-right bubble exists from 640 up (also with a floating sidebar), so no `narrowTarget`; phones have no bubble, "version history" is an item in the header ⋮.
    target: () => all(findTourTarget("versions")),
    phoneTarget: () => all(noteMenu()),
    // A collapsed stack hides the bubble the text is about; the person's choice comes back after the stop.
    prepare: () => showCornerStackForNow(true),
    prepareInNarrow: true,
    leave: () => showCornerStackForNow(false),
  },
  knowledge: {
    id: "knowledge",
    titleKey: "tourGuide.stops.knowledge.title",
    bodyKey: "tourGuide.stops.knowledge.body",
    phoneBodyKey: "tourGuide.stops.knowledge.phoneBody",
    // The sample note's heading is seeded with knowledge info; if the user removed it the icon is gone and the step is skipped.
    target: sampleKnowledgeIcon,
    leave: () => {
      scrolledKnowledgeIcon = null;
    },
  },
  tags: {
    id: "tags",
    titleKey: "tourGuide.stops.tags.title",
    bodyKey: "tourGuide.stops.tags.body",
    phoneBodyKey: "tourGuide.stops.tags.phoneBody",
    // The tag row is drawn only when a note has tags, and a tag stays in the space after its note is trashed, so the step points at ⋮ ("Add tag") instead of tagging the sample note.
    target: () => all(noteMenu()),
  },
  wikilink: {
    id: "wikilink",
    titleKey: "tourGuide.stops.wikilink.title",
    bodyKey: "tourGuide.stops.wikilink.body",
    target: (ctx) => liveTriggerTarget(ctx.sampleNoteId, "[[", "wikilinkMenu", "wikilink"),
    prepare: (ctx) => {
      if (ctx.liveStops) startLiveTrigger(ctx.sampleNoteId, "[[");
    },
    prepareInNarrow: true,
    leave: (ctx) => stopLiveTrigger(ctx.sampleNoteId),
    live: (ctx) => ctx.liveStops,
  },
  ai: {
    id: "ai",
    titleKey: "tourGuide.stops.ai.title",
    bodyKey: "tourGuide.stops.ai.body",
    target: () => liveSelectionTarget(),
    prepare: (ctx) => startLiveSelection(ctx.sampleNoteId),
    prepareInNarrow: true,
    leave: (ctx) => stopLiveSelection(ctx.sampleNoteId),
    precondition: (ctx) => ctx.aiActions.length > 0,
    // Phone doesn't show the format toolbar on selection; the AI button sits in the toolbar above the keyboard, and demoing it would raise the keyboard over half the screen, so phones skip this step.
    skipOnPhone: true,
    // Only selects, needs no empty paragraph, so `liveStops` isn't checked; no editor for the sample note = not a demo.
    live: (ctx) => getTourNoteEditor(ctx.sampleNoteId) !== null,
  },
  slash: {
    id: "slash",
    titleKey: "tourGuide.stops.slash.title",
    bodyKey: "tourGuide.stops.slash.body",
    phoneBodyKey: "tourGuide.stops.slash.phoneBody",
    target: (ctx) => {
      const base = liveTriggerTarget(ctx.sampleNoteId, "/", "slashMenu", "flowchart");
      if (base.length === 0) return base;
      const chart = findInSampleEditor(ctx.sampleNoteId, "flowchart");
      return chart === null || base.includes(chart) ? base : [...base, chart];
    },
    prepare: (ctx) => {
      if (ctx.liveStops) startLiveTrigger(ctx.sampleNoteId, "/");
    },
    prepareInNarrow: true,
    leave: (ctx) => stopLiveTrigger(ctx.sampleNoteId),
    live: (ctx) => ctx.liveStops,
  },
  userMenu: {
    id: "userMenu",
    titleKey: "tourGuide.stops.userMenu.title",
    bodyKey: "tourGuide.stops.userMenu.body",
    narrowBodyKey: "tourGuide.stops.userMenu.narrowBody",
    phoneBodyKey: "tourGuide.stops.userMenu.phoneBody",
    // No phoneTarget: on phones the trigger is the list header's avatar, which carries the same attribute.
    target: () => all(findUserMenuTrigger()),
    narrowTarget: drawerButton,
    phoneScreen: "list",
  },
};

export const FULL_TOUR: readonly [StopId, ...StopId[]] = ["tabs", "newNote", "folders", "search", "header", "versions", "knowledge", "tags", "wikilink", "ai", "slash", "userMenu"];

// The exported helpers below default `layout` to a one-time `tourLayout()` read; components subscribed to layout changes pass their value.
export function stopShownIn(stop: StopDef, layout: TourLayout = tourLayout()): boolean {
  return !(layout === "phone" && stop.skipOnPhone === true);
}

export function stopScreen(stop: StopDef, layout: TourLayout = tourLayout()): TourScreen {
  return layout === "phone" && stop.phoneScreen === "list" ? "list" : "note";
}

export function stopTarget(stop: StopDef, ctx: StopContext, layout: TourLayout = tourLayout()): Element[] {
  if (!stopShownIn(stop, layout)) return [];
  if (layout === "phone") return (stop.phoneTarget ?? stop.target)(ctx);
  if (layout === "floating") return (stop.narrowTarget ?? stop.target)(ctx);
  return stop.target(ctx);
}

/** Not exported: callers must go through `stopBody`, or `{{mod}}` is missed. */
function stopBodyKey(stop: StopDef, layout: TourLayout): string {
  if (layout === "phone") return stop.phoneBodyKey ?? stop.bodyKey;
  if (layout === "floating") return stop.narrowBodyKey ?? stop.bodyKey;
  return stop.bodyKey;
}

export function stopBody(t: TFunction, stop: StopDef, layout: TourLayout = tourLayout()): string {
  return t(stopBodyKey(stop, layout), { mod: isMacPlatform() ? "⌘" : "Ctrl+" });
}

export function prepareStop(stop: StopDef, ctx: StopContext): void {
  const layout = tourLayout();
  if (!stopShownIn(stop, layout)) return;
  if (layout === "floating" && stop.prepareInNarrow !== true) return;
  stop.prepare?.(ctx);
}
