import { Extension } from "@tiptap/core";
import { knowledgeIdRenewals } from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";
import { createPmPlugin } from "./pm-plugin";
import { pmDocHasKnowledge, scanPmKnowledge, transactionMayAddKnowledge } from "./knowledge-pm";
import { Y_SYNC_META } from "./site-link-pm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Transaction/EditorState types can't be imported: prosemirror-state isn't an apps/web dependency
type Any = any;

const OWN_META = "knotebook:knowledgeIdRenewal";

function renewalTransaction(state: Any, insertedRanges: ReadonlyArray<readonly [number, number]> | null): Any | null {
  if (!pmDocHasKnowledge(state.doc)) return null;
  const { items, headingPos } = scanPmKnowledge(state.doc, false);
  const known = items.flatMap((item, index) => {
    const pos = headingPos[index]!;
    if (pos < 0) return [];
    const knowledgeId = (item.heading!.props as { knowledgeId: string }).knowledgeId;
    return [{ blockId: item.blockId, knowledgeId, pos, inserted: insertedRanges?.some(([from, to]) => from <= pos && pos < to) ?? false }];
  });
  const renewals = knowledgeIdRenewals(known);
  if (renewals.length === 0) return null;
  const tr = state.tr;
  for (const renewal of renewals) tr.setNodeAttribute(known[renewal.index]!.pos, "knowledgeId", renewal.knowledgeId);
  tr.setMeta(OWN_META, true);
  return tr;
}

// Where the batch put new content, in the coordinates of its final document.
function insertedRanges(trs: readonly Any[]): Array<readonly [number, number]> {
  let ranges: Array<[number, number]> = [];
  for (const tr of trs) {
    for (const step of tr.steps as Any[]) {
      const map = step.getMap();
      ranges = ranges.map(([from, to]) => [map.map(from, 1), map.map(to, -1)]);
      map.forEach((_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => {
        if (newEnd > newStart) ranges.push([newStart, newEnd]);
      });
    }
  }
  return ranges;
}

/**
 * Two headings must never share a knowledge id. A local edit is fixed in the same transaction (one Yjs transaction, one undo step).
 * Remote, undo/redo and first-load changes arrive inside y-prosemirror's lock, where an appended transaction is not written to Yjs, so those are fixed by a separate dispatch right after.
 */
export function createKnowledgeIdExtension(opts: { editorRef: EditorRef }): Extension {
  return Extension.create({
    name: "knotebookKnowledgeIds",
    addProseMirrorPlugins() {
      const editable = () => opts.editorRef.current?.isEditable === true;
      let dirty = false;
      return [
        createPmPlugin({
          state: {
            init: () => null,
            apply: (tr: Any) => {
              if (tr.docChanged && tr.getMeta(Y_SYNC_META) !== undefined) dirty = true;
              return null;
            },
          },
          appendTransaction: (trs: readonly Any[], _oldState: Any, newState: Any) => {
            if (!editable()) return null;
            if (trs.some((tr) => tr.getMeta(OWN_META) === true || tr.getMeta(Y_SYNC_META) !== undefined)) return null;
            if (!trs.some((tr) => tr.docChanged && transactionMayAddKnowledge(tr))) return null;
            return renewalTransaction(newState, insertedRanges(trs));
          },
          view: (view: Any) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            let wasEditable = false;
            const run = () => {
              timer = null;
              if (view.isDestroyed || !editable()) return;
              const tr = renewalTransaction(view.state, null);
              if (!tr) return;
              // Not part of the user's history: undo must not turn the renewed id back into the duplicate.
              tr.setMeta("addToHistory", false);
              view.dispatch(tr);
            };
            // A mounted view is not necessarily followed by another update (remounting for editability, a note opened with nothing else pending), so the first check is scheduled here.
            timer = setTimeout(run, 0);
            return {
              update: () => {
                const now = editable();
                // An editor that turns editable without being remounted (the flag flips and the view updates).
                if (now && !wasEditable) dirty = true;
                wasEditable = now;
                if (!dirty) return;
                dirty = false;
                timer ??= setTimeout(run, 0);
              },
              destroy: () => {
                if (timer !== null) clearTimeout(timer);
                timer = null;
              },
            };
          },
        } as never) as never,
      ];
    },
  });
}
