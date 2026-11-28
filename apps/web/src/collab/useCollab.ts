import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { INITIAL_COLLAB_STATE, type CollabState } from "./connection";
import { acquireNoteConnection } from "./note-connection";

export { collabUrl, type CollabTokenResponse } from "./note-connection";

/**
 * Must exceed the server's persist debounce (2 s, `maxDebounce` 10 s, `STORE_DEBOUNCE_MS`): the
 * re-fetch reads `last_edited_*`, written only after `onStoreDocument` (#106). The timers start
 * at different moments, so the margin is about 1 s minus network and persist time; if exceeded,
 * the re-fetch returns the old value until the next edit or window focus.
 */
const DOC_UPDATE_DEBOUNCE_MS = 3_000;

/**
 * Counts both remote updates (origin = the provider) and local typing (origin =
 * `ySyncPluginKey`): the server also writes `last_edited_*` for the user's own typing (#138).
 * Guarded by `useCollab.doc-update.test.ts`.
 */
export function createDocUpdateDebouncer(doc: Y.Doc, onDocUpdate: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const handleUpdate = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onDocUpdate, delayMs);
  };
  doc.on("update", handleUpdate);
  return () => {
    doc.off("update", handleUpdate);
    if (timer) clearTimeout(timer);
  };
}

export interface UseCollabOptions {
  /** Note uuid, not a slug or canonical ref; undefined = not resolved yet (no connection). */
  noteId: string | undefined;
  onUnauthorized: () => void;
  /** Debounced; excludes the initial sync batch. Invalidating the note query is the caller's job (this hook doesn't touch the router or query cache). */
  onDocUpdate?: () => void;
}

export interface UseCollabResult {
  state: CollabState;
  /** Acquired inside the effect so StrictMode can release it correctly. */
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  /**
   * Sticky across disconnects (offline edits after a first sync are legitimately merged back,
   * #39); reset on note change, where the new empty Y.Doc looks like a blank note: callers use
   * it to block typing into one that vanishes on reload (#48).
   */
  synced: boolean;
  /**
   * #269: the paragraph anchor is consumed on this, not `synced`: `synced` resets only at the
   * start of the new note's connection effect, so the first commit of A → B still carries A's
   * `synced === true`.
   */
  syncedFor: string | null;
}

export function useCollab({ noteId, onUnauthorized, onDocUpdate }: UseCollabOptions): UseCollabResult {
  const [state, setState] = useState<CollabState>(INITIAL_COLLAB_STATE);
  const [session, setSession] = useState<{ doc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const [synced, setSynced] = useState(false);
  const [syncedFor, setSyncedFor] = useState<string | null>(null);

  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  // Via a ref so a new callback identity per caller render doesn't rebuild the connection (deps stay `[noteId]`).
  const onDocUpdateRef = useRef(onDocUpdate);
  onDocUpdateRef.current = onDocUpdate;

  useEffect(() => {
    if (!noteId) return;

    const handle = acquireNoteConnection(noteId, { kind: "editor", onUnauthorized: () => onUnauthorizedRef.current() });
    // The doc-update debounce (#106) attaches once synced, not on acquire, or the initial sync
    // batch would invalidate the note query on page open; `??=` keeps a reconnect from attaching
    // twice. A connection another holder already synced attaches at once.
    let disposeDocUpdate: (() => void) | undefined;
    // A connection shared with another holder may already be synced: state, synced and the
    // session land in one batch, so the editor never renders the shared doc as "not loaded".
    const read = () => {
      setState(handle.getState());
      const isSynced = handle.isSynced();
      setSynced(isSynced);
      setSyncedFor(isSynced ? noteId : null);
      if (isSynced) disposeDocUpdate ??= createDocUpdateDebouncer(handle.doc, () => onDocUpdateRef.current?.(), DOC_UPDATE_DEBOUNCE_MS);
    };
    const unsubscribe = handle.subscribe(read);
    read();
    setSession({ doc: handle.doc, provider: handle.provider });

    return () => {
      unsubscribe();
      disposeDocUpdate?.();
      handle.release();
      setSession(null);
      setSyncedFor(null);
    };
  }, [noteId]);

  return { state, doc: session?.doc ?? null, provider: session?.provider ?? null, synced, syncedFor };
}
