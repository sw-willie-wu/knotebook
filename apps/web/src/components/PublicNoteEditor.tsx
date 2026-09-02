// 與 NoteEditor.tsx 同一支樣式入口（`@blocknote/mantine/style.css` 自帶 react/core 的
// 樣式鏈）；兩個模組同在 BlockNote 共用 chunk 裡，這裡再 import 一次是零成本的保險
// ——公開頁不得倚賴「NoteEditor 恰好也被載入」才有樣式。
import "@blocknote/mantine/style.css";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { buildReadonlyNoteEditorOptions } from "@/collab/editor-options";
import type { PublicNoteRef } from "@/lib/public-note-ref";
import { useTheme } from "@/theme";

export interface PublicNoteEditorProps {
  /** `decodePublicYdoc` 解出來的快照文件——本元件只讀不寫（沒有 provider、沒有連線）。 */
  doc: Y.Doc;
  /** 公開頁把手（#122 PR3 起兩形）：`resolveFileUrl` 依形組公開圖端點路徑要用。 */
  publicRef: PublicNoteRef;
}

/**
 * 公開唯讀頁的 BlockNote 檢視（#72 Task 3）。比照 `NoteEditor` 的拆分理由：BlockNote
 * 依賴大量 jsdom 沒有的 DOM/Range API，頁面層測試把這個模組 mock 掉、只驗 props 接線
 * （`PublicNotePage.test.tsx`）；選項本身的契約守在 `collab/editor-options.test.ts`。
 *
 * Task 0 spike 定案：`withCollaboration`＋local `new Awareness(doc)`＋`editable={false}`
 * 在無 provider 下正常渲染（含 code/mermaid lazy 鏈）；**不掛 useCollab、不打
 * collab-token**（也沒有 noteId 可打）。
 */
export function PublicNoteEditor({ doc, publicRef }: PublicNoteEditorProps) {
  const { i18n } = useTranslation();
  const { resolvedTheme } = useTheme();

  // local Awareness（y-protocols）：BlockNote 的 collaboration.provider 只吃
  // `{ awareness }` 裸物件。unmount 時 destroy——Awareness 建構子掛了內部計時器
  // （outdated state 檢查），不收會漏 interval。StrictMode（dev-only）下有兩個已知
  // 且接受的小瑕疵：useMemo 雙跑棄置的第一顆到頁面卸載才消失；存活那顆會被模擬
  // unmount destroy 一次後續用——唯讀頁無 peer、production 無雙跑，不為此繞路。
  const awareness = useMemo(() => new Awareness(doc), [doc]);
  useEffect(() => () => awareness.destroy(), [awareness]);

  // deps 用逐值展開的識別字串，**不放 publicRef 物件本身**——防禦性寫法：不倚賴
  // 呼叫端有 useMemo（現行 PublicNotePage 有 memo、identity 穩定；這裡只是不把
  // 編輯器重建與否綁在上游的 memo 紀律上）。「同一掛載換 ref」在現行資料流到不了
  // （ref 變→query key 變→data 清空→本元件先卸載），此 deps 不替那條路背書。
  const publicRefIdentity =
    publicRef.kind === "token" ? `token:${publicRef.token}` : `path:${publicRef.handle}/${publicRef.slug}`;
  const editor = useCreateBlockNote(
    buildReadonlyNoteEditorOptions({ doc, awareness, publicRef, language: i18n.language }),
    // 語言刻意不進 deps（與 NoteEditor 同一條理由：字典只在建立時讀一次）。
    [doc, awareness, publicRefIdentity],
  );

  // editable={false}：BlockNote 不會渲染任何輸入介面（formatting toolbar／slash／
  // file panel 都只在可編輯時觸發），不必逐一關閉 controller。
  return <BlockNoteView editor={editor} editable={false} theme={resolvedTheme} data-testid="public-note-editor" />;
}
