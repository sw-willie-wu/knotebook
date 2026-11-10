import type { BlockNoteEditor } from "@blocknote/core";
import { collabUndoManager } from "@/collab/undo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;

/**
 * 結構操作自成一個撤銷步：前後各 `stopCapturing()`，不跟前後的打字併成同一步。
 * 非共編編輯器（`history` extension）沒有 UndoManager，只跑 `run`。
 */
export function asUndoStep<T>(editor: AnyEditor, run: () => T): T {
  const manager = collabUndoManager(editor);
  manager?.stopCapturing();
  try {
    return run();
  } finally {
    manager?.stopCapturing();
  }
}
