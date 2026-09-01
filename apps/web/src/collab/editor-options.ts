import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { blocknoteZhTW } from "@/i18n/blocknote-zh-TW";
import { publicMediaUrl } from "@/lib/public-media-url";

/**
 * 編輯頁（`NoteEditor` 的 `buildNoteEditorOptions`）與公開唯讀頁
 * （{@link buildReadonlyNoteEditorOptions}）共用的選項底層（#72 Task 3 抽出）——
 * schema／字典／collaboration 三件事兩邊必須一致，各寫一份的漂移症狀都很陰
 * （fragment 名寫錯＝空白頁零錯誤；schema 不同＝同一篇筆記兩頁渲染不同）。
 */
export interface CollabEditorBaseInput {
  doc: Y.Doc;
  /** 共編游標協定物件。BlockNote 的 collaboration.provider 實際上只吃 `{ awareness }`
   * 裸物件（編輯頁傳 HocuspocusProvider 的、唯讀頁傳 local `new Awareness(doc)`）。 */
  awareness: Awareness | undefined;
  /** i18next 目前的語言代碼（`i18n.language`）。 */
  language: string;
  /** 共編游標的名牌。唯讀頁沒有 cursor 顯示，給匿名替身即可（withCollaboration
   * 的 user 必填——Task 0 spike 實證）。 */
  user: { id?: string; name: string; color: string };
}

export function buildCollabEditorBase({ doc, awareness, language, user }: CollabEditorBaseInput) {
  return {
    schema: noteSchema,
    // BlockNote 的預設字典就是英文，只有 zh-TW 需要換掉。
    dictionary: language.startsWith("zh") ? blocknoteZhTW : undefined,
    collaboration: {
      provider: { awareness },
      // fragment 名稱用 `@knotebook/shared` 的 `YDOC_FRAGMENT`——server 端
      // `collab/store.ts` 存取的是同一個名字，任何一邊寫死字串就會變成兩份互不相干
      // 的文件（看起來像「同步壞掉」，其實是連錯文件）。
      fragment: doc.getXmlFragment(YDOC_FRAGMENT),
      user,
    },
  };
}

export interface ReadonlyNoteEditorOptionsInput {
  doc: Y.Doc;
  /** local `new Awareness(doc)`（y-protocols）——唯讀頁沒有連線，不掛 HocuspocusProvider。 */
  awareness: Awareness;
  /** 公開分享 token：`resolveFileUrl` 要把自家上傳網址映射到免登入的公開圖端點。 */
  token: string;
  language: string;
}

/**
 * 公開唯讀頁（`/p/:token`）的編輯器選項。與編輯頁共用 {@link buildCollabEditorBase}；
 * 差異只有兩件事：
 * - `resolveFileUrl` 換成 {@link publicMediaUrl}（匿名端沒 session，`/api/uploads/:id`
 *   必 401——先過 safeMediaUrl 再映射到 `/api/public/notes/:token/uploads/:id`）。
 * - **不掛任何編輯用選項**（uploadFile／pasteHandler／`_tiptapOptions` 的輸入攔截與
 *   `[[` 偵測）：唯讀頁沒有輸入路徑，掛了就是多餘的攻擊面。`editable={false}` 由
 *   `PublicNoteEditor` 的 `BlockNoteView` 負責。
 */
export function buildReadonlyNoteEditorOptions({ doc, awareness, token, language }: ReadonlyNoteEditorOptionsInput) {
  const resolvePublicUrl = publicMediaUrl(token);
  return withCollaboration({
    ...buildCollabEditorBase({
      doc,
      awareness,
      language,
      // 匿名替身：name/color 必填但唯讀下不會渲染任何 cursor 名牌，值不承重。
      user: { name: "", color: "#888888" },
    }),
    resolveFileUrl: (url: string) => Promise.resolve(resolvePublicUrl(url)),
  });
}
