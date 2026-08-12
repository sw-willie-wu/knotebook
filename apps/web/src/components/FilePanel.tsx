import { useCallback, useState, type ChangeEvent, type FC, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { filenameFromURL } from "@blocknote/core";
import { useBlockNoteEditor, type FilePanelProps } from "@blocknote/react";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postUpload } from "@/uploads/upload-file";

/** `noteSchema` 恢復啟用的 image block 型別名（`@blocknote/core` 的 `image` block spec）。 */
const IMAGE_BLOCK_TYPE = "image";

/**
 * image block 專屬的自家 Upload tab（spec §12.4、上輪審查者的 Important）。
 *
 * **刻意不用 `editor.uploadFile`**：`@blocknote/react` 內建的 `UploadTab` 呼叫
 * `editor.uploadFile(file, blockId)`——這裡的 `blockId` 是**使用者已經存在的 block**
 * （FilePanel 的「換檔」流程：先有一個 image/file/... block，使用者點開它換一個檔案），
 * 不是貼上/拖放時 `handleFileInsertion` 建的 placeholder block。但 Task 13 的
 * `createUploadFile`（給 `buildNoteEditorOptions` 的 `uploadFile` 選項用）失敗時會把
 * `blockId` 對應的 block **整個刪掉**——那段清除邏輯的前提是「這個 block 是失敗上傳
 * 自己建的 placeholder，反正使用者還沒看到內容」，套在「使用者刻意留著、想換檔」的
 * 既有 block 上就變成誤刪。所以這裡直接呼叫低階的 `postUpload`（可 reject、呼叫端
 * 自己接手錯誤），成功才 `editor.updateBlock`、失敗只顯示行內錯誤、**不動 block**。
 */
function UploadTab({ noteId, blockId }: { noteId: string; blockId: string }) {
  const { t } = useTranslation();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/wikilink/menu.ts）
  const editor = useBlockNoteEditor<any, any, any>();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // 清掉 input value：不這樣做的話，使用者選同一個檔案重試一次時（失敗後）
      // `onChange` 不會再觸發（瀏覽器對「同一個 value」不視為變更）。
      event.target.value = "";
      if (!file) {
        return;
      }

      setError(null);
      setUploading(true);
      postUpload(noteId, file).then(
        ({ url }) => {
          setUploading(false);
          // `postUpload` 這段等待期間，使用者可能已經把這個 block 刪掉（連帶
          // `FilePanelExtension` 因文件變動 `closeMenu()`、面板關閉但這個 promise
          // continuation 仍會跑）——`editor.updateBlock` 對著不存在的 id 會直接
          // throw，這裡跟 Task 13 `createUploadFile` 的清除邏輯同一個防線：
          // 先確認 block 還在才動手。
          try {
            if (editor.getBlock(blockId)) {
              editor.updateBlock(blockId, { props: { url } });
            }
          } catch {
            // 同上：block 已消失或 editor 已卸載，靜默略過。
          }
        },
        (err: unknown) => {
          setUploading(false);
          // 審查修復（Important 2）：`postUpload` 前驗（檔案太大）reject 是最常見的
          // 失敗案例，`errors.file_too_large` 兩語系文案已經存在（Task 13/11+）——
          // 通用文案「請再試一次」套在這種情形上是誤導的（原檔案再試一次還是太大，
          // 永遠不會成功）。`err instanceof ApiFail` 且 `errors.<code>` 查得到就用它
          // （`defaultValue` 保底：不是 `ApiFail`、或是查不到的陌生 code，才落回這裡
          // 唯一的通用文案 `note.filePanel.upload.error`）。
          const code = err instanceof ApiFail ? err.code : undefined;
          setError(code ? t(`errors.${code}`, { defaultValue: t("note.filePanel.upload.error") }) : t("note.filePanel.upload.error"));
        },
      );
    },
    [noteId, blockId, editor, t],
  );

  return (
    <div className="space-y-2 p-3">
      <label htmlFor={`filepanel-upload-${blockId}`} className="block text-xs font-medium text-muted-foreground">
        {t("note.filePanel.upload.inputLabel")}
      </label>
      <Input
        id={`filepanel-upload-${blockId}`}
        type="file"
        accept="image/*"
        disabled={uploading}
        onChange={handleChange}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 安全 backlog ④（spec §13.2/§13.5）：Embed tab 的 URL scheme 白名單。`new URL(raw)`
 * throw（含最常見的「沒帶 scheme」，例如 `example.com/a.png`——`URL` 建構子不會替它
 * 猜一個 scheme，而是直接丟例外）一律視為不合法；能成功解析的，`scheme` 只放行
 * `http:`／`https:`，其餘（`javascript:`、`data:`、`file:`……）一律拒收。**刻意不自動
 * 補 scheme**——單一行為、沒有猜測，使用者看到拒收就得自己把完整網址（含
 * `http(s)://`）貼進來。
 */
function isAllowedEmbedUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Embed tab：貼網址直接寫回 block props，四種檔案類 block（image/audio/video/file）
 * 共用同一份實作——不區分型別，`filenameFromURL`（`@blocknote/core` 匯出）從網址猜
 * 檔名，跟 BlockNote 自己的 `EmbedTab` 邏輯一致。
 */
function EmbedTab({ blockId }: { blockId: string }) {
  const { t } = useTranslation();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同上）
  const editor = useBlockNoteEditor<any, any, any>();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    if (!isAllowedEmbedUrl(trimmed)) {
      setError(t("note.filePanel.embed.invalidUrl"));
      return;
    }
    setError(null);
    editor.updateBlock(blockId, { props: { name: filenameFromURL(trimmed), url: trimmed } });
  }, [editor, blockId, url, t]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // `isComposing` 防中文/日文輸入法選字時的 Enter 誤觸（同 wikilink EmbedTab 慣例）。
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <div className="space-y-2 p-3">
      <label htmlFor={`filepanel-embed-${blockId}`} className="block text-xs font-medium text-muted-foreground">
        {t("note.filePanel.embed.urlLabel")}
      </label>
      <Input
        id={`filepanel-embed-${blockId}`}
        type="url"
        placeholder={t("note.filePanel.embed.urlPlaceholder")}
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={handleKeyDown}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button type="button" size="sm" onClick={submit} disabled={url.trim().length === 0}>
        {t("note.filePanel.embed.embedButton")}
      </Button>
    </div>
  );
}

/**
 * 建出交給 `<FilePanelController filePanel={...}>` 的元件（Task 14）。
 *
 * `FilePanelProps` 只有 `blockId`（`@blocknote/react` 的型別）——`noteId` 得靠這層
 * closure 帶進去。呼叫端（`NoteEditor.tsx`）**必須**把回傳值 `useMemo` 起來、只在
 * `noteId` 真的換手時才重建：每次 render 都呼叫這支拿到的是**新的元件型別**，
 * `FilePanelController` 認不出它跟上一輪是同一個元件，會把它當成「換了一個元件」
 * 整個卸載重掛——使用者在 Embed URL 輸入到一半，面板就會被清空重來。
 */
export function createFilePanel(noteId: string): FC<FilePanelProps> {
  return function MyFilePanel({ blockId }: FilePanelProps) {
    const { t } = useTranslation();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同上）
    const editor = useBlockNoteEditor<any, any, any>();
    const block = editor.getBlock(blockId)!;
    const isImage = block.type === IMAGE_BLOCK_TYPE;

    const [requestedTab, setRequestedTab] = useState<"upload" | "embed">("upload");
    // 非 image block（audio/video/file）只有 Embed tab——沒有分頁列可切換，
    // 不管 `requestedTab` 是什麼一律落在 embed。
    const activeTab = isImage ? requestedTab : "embed";

    return (
      <div className="w-72 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
        {isImage && (
          <div className="flex border-b border-border" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "upload"}
              className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                activeTab === "upload"
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setRequestedTab("upload")}
            >
              {t("note.filePanel.upload.tabLabel")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "embed"}
              className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                activeTab === "embed"
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setRequestedTab("embed")}
            >
              {t("note.filePanel.embed.tabLabel")}
            </button>
          </div>
        )}
        {activeTab === "upload" ? <UploadTab noteId={noteId} blockId={blockId} /> : <EmbedTab blockId={blockId} />}
      </div>
    );
  };
}
