import type { Awareness } from "y-protocols/awareness";
import { sanitizeRemoteStates } from "./remote-states";

// y-prosemirror yCursorPlugin's default cursorStateField.
export const CURSOR_FIELD = "cursor";

/**
 * #293: drops non-null `cursor` writes while read-only. BlockNote 0.52.1 always gives `.ProseMirror` `tabIndex="0"`, and the y-prosemirror cursor plugin writes `cursor` on `focusin` and every view update
 * based only on `view.hasFocus()`, with no option to disable it; making the editor unfocusable would stop read-only users from selecting and copying.
 * - Only `setLocalStateField("cursor", …)` is intercepted (`setLocalState({ cursor })` would bypass it; no caller does that). null always passes: clearing on blur, and the old plugin's destroy on the read-only remount (`NoteEditor.cursor.test.tsx`).
 * - #312: `getStates()` returns sanitised remote states (`remote-states.ts`); only the copy handed to BlockNote is wrapped, the avatar row reads the raw provider awareness.
 */
export function gateLocalCursor(awareness: Awareness, canSend: () => boolean): Awareness {
  const setLocalStateField = (field: string, value: unknown): void => {
    if (field === CURSOR_FIELD && value != null && !canSend()) return;
    awareness.setLocalStateField(field, value);
  };
  return new Proxy(awareness, {
    get(target, prop) {
      if (prop === "setLocalStateField") return setLocalStateField;
      if (prop === "getStates") return () => sanitizeRemoteStates(target.getStates());
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
