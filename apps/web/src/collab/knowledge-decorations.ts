import { Extension } from "@tiptap/core";
import { listKnowledge, type KnowledgeEntry } from "@knotebook/shared";
// Must be the same prosemirror-view copy BlockNote uses (see `code-block-caret`).
import { Decoration, DecorationSet } from "prosemirror-view";
import { createPmPlugin } from "./pm-plugin";
import { pmDocHasKnowledge, scanPmKnowledge, transactionMayAddKnowledge } from "./knowledge-pm";
import { Y_SYNC_META } from "./site-link-pm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Transaction/EditorState types can't be imported: prosemirror-state isn't an apps/web dependency
type Any = any;

export const KNOWLEDGE_OUTDATED_ATTR = "data-kb-knowledge-outdated";

interface DecorationState {
  entries: readonly KnowledgeEntry[];
  decorations: DecorationSet;
}

const EMPTY: DecorationState = { entries: [], decorations: DecorationSet.empty };
// `Plugin` isn't importable, so the plugin is found in `state.plugins` by this marker on its spec.
const MARKER = "knotebookKnowledgeDecorations";

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function sameEntry(a: KnowledgeEntry, b: KnowledgeEntry): boolean {
  return (
    a.blockId === b.blockId && a.level === b.level && a.heading === b.heading && a.parentBlockId === b.parentBlockId &&
    a.outdated === b.outdated && a.icon === b.icon &&
    a.info.id === b.info.id && a.info.when === b.info.when && a.info.conclusion === b.info.conclusion && a.info.evidence === b.info.evidence &&
    a.info.verified === b.info.verified && a.info.status === b.info.status && a.info.supersededBy === b.info.supersededBy &&
    sameList(a.ancestorBlockIds, b.ancestorBlockIds) && sameList(a.rangeBlockIds, b.rangeBlockIds)
  );
}

function compute(doc: Any, previous: readonly KnowledgeEntry[]): DecorationState {
  const { items, headingPos } = scanPmKnowledge(doc);
  const fresh = listKnowledge(items);
  // The entries line up with the knowledge headings in document order, so positions are matched by order, not by block id.
  const positions = headingPos.filter((pos) => pos >= 0);
  const decorations: Decoration[] = [];
  fresh.forEach((entry, i) => {
    if (entry.outdated) decorations.push(Decoration.node(positions[i]!, positions[i]! + doc.nodeAt(positions[i]!).nodeSize, { [KNOWLEDGE_OUTDATED_ATTR]: "" }));
  });
  // Same content keeps the same array, so consumers that compare by identity don't redraw on every keystroke.
  const entries = previous.length === fresh.length && fresh.every((e, i) => sameEntry(e, previous[i]!)) ? previous : fresh;
  return { entries, decorations: decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty };
}

/**
 * True when every step only replaces inline content inside one textblock that is not a heading (typing, deleting text, marks):
 * no block is added, removed or re-parented and no heading changes, so the entries are still right and only decoration positions move.
 */
function onlyEditsPlainText(tr: Any): boolean {
  const steps = tr.steps as Any[];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if ("gapFrom" in step || "attr" in step || !("from" in step)) return false;
    if ("slice" in step) {
      const { slice } = step;
      if (slice.openStart !== 0 || slice.openEnd !== 0) return false;
      for (let c = 0; c < slice.content.childCount; c += 1) if (!slice.content.child(c).isInline) return false;
    } else if (!("mark" in step)) {
      return false;
    }
    const doc = tr.docs[i];
    const $from = doc.resolve(step.from);
    if (!$from.parent.isTextblock || $from.parent.type.name === "heading" || !$from.sameParent(doc.resolve(step.to))) return false;
  }
  return true;
}

function next(tr: Any, value: DecorationState, _oldState: Any, newState: Any): DecorationState {
  if (!tr.docChanged) return value;
  // A remote or undo transaction replaces content wholesale, so its steps say nothing about what is inside.
  const local = tr.getMeta(Y_SYNC_META) === undefined;
  if (value.entries.length === 0) {
    if (local ? !transactionMayAddKnowledge(tr) : !pmDocHasKnowledge(newState.doc)) return value;
  } else if (local && onlyEditsPlainText(tr)) {
    return { entries: value.entries, decorations: value.decorations.map(tr.mapping, newState.doc) };
  }
  return compute(newState.doc, value.entries);
}

export function createKnowledgeDecorationExtension(): Extension {
  return Extension.create({
    name: "knotebookKnowledgeDecorations",
    addProseMirrorPlugins() {
      return [
        createPmPlugin({
          [MARKER]: true,
          state: {
            init: (_config: Any, state: Any) => (pmDocHasKnowledge(state.doc) ? compute(state.doc, []) : EMPTY),
            apply: next,
          },
          // ProseMirror calls prop functions with the plugin as `this`.
          props: {
            decorations(this: Any, state: Any) {
              return (this.getState(state) as DecorationState).decorations;
            },
          },
        } as never) as never,
      ];
    },
  });
}

export function knowledgeEntriesOf(state: Any): readonly KnowledgeEntry[] {
  const found = (state.plugins as Any[]).find((p) => p.spec?.[MARKER] === true);
  return (found?.getState(state) as DecorationState | undefined)?.entries ?? [];
}
