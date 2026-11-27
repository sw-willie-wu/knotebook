import { useCallback, useState, type ChangeEvent, type FC, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { filenameFromURL } from "@blocknote/core";
import { useBlockNoteEditor, type FilePanelProps } from "@blocknote/react";
import { useAuthConfig } from "@/api/authConfig";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postUpload, storageQuotaDescription } from "@/uploads/upload-file";
import { isAllowedEmbedUrl } from "@/lib/media-url";
import { uploadErrorKey } from "@/lib/upload-error-text";

const IMAGE_BLOCK_TYPE = "image";

/** Not `editor.uploadFile`: BlockNote built-in `UploadTab` calls it with the id of a block the user already has (replace-file flow), and `createUploadFile` deletes that block on failure (meant for a fresh placeholder). So call `postUpload` directly, update the block only on success, and on failure show an inline error and leave the block alone. */
function UploadTab({ noteId, blockId }: { noteId: string; blockId: string }) {
  const { t } = useTranslation();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
  const editor = useBlockNoteEditor<any, any, any>();
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const maxUploadBytes = useAuthConfig().data?.maxUploadBytes;

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Clear the value so choosing the same file again after a failure fires `onChange`.
      event.target.value = "";
      if (!file) {
        return;
      }

      setError(null);
      setUploading(true);
      postUpload(noteId, file, maxUploadBytes).then(
        ({ url }) => {
          setUploading(false);
          // The block may have been deleted while `postUpload` was awaited (the panel closes but this continuation still runs); `updateBlock` throws on a missing id, so check first.
          try {
            if (editor.getBlock(blockId)) {
              editor.updateBlock(blockId, { props: { url } });
            }
          } catch {
          }
        },
        (err: unknown) => {
          setUploading(false);
          // `uploadErrorKey` picks the most specific text (e.g. file_too_large, or the SVG-specific one) because the generic "try again" would mislead; `defaultValue` falls back to it when no translation exists.
          const code = err instanceof ApiFail ? err.code : undefined;
          const key = uploadErrorKey(err, file);
          const title = key ? t(key, { defaultValue: t("note.filePanel.upload.error") }) : t("note.filePanel.upload.error");
          setError(err instanceof ApiFail && code === "storage_quota_exceeded" ? { title, detail: storageQuotaDescription(err, t) } : { title });
        },
      );
    },
    [noteId, blockId, editor, t, maxUploadBytes],
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
          <span className="block">{error.title}</span>
          {error.detail !== undefined && <span className="block">{error.detail}</span>}
        </p>
      )}
    </div>
  );
}

function EmbedTab({ blockId }: { blockId: string }) {
  const { t } = useTranslation();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
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
      // `isComposing`: ignore the Enter that confirms an IME candidate.
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
      <Button type="button" variant="brandDeep" onClick={submit} disabled={url.trim().length === 0}>
        {t("note.filePanel.embed.embedButton")}
      </Button>
    </div>
  );
}

/** Must be `useMemo`d by the caller and rebuilt only when `noteId` changes: each call returns a new component type, which `FilePanelController` would unmount and remount (wiping a half-typed URL). */
export function createFilePanel(noteId: string): FC<FilePanelProps> {
  return function MyFilePanel({ blockId }: FilePanelProps) {
    const { t } = useTranslation();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
    const editor = useBlockNoteEditor<any, any, any>();
    const block = editor.getBlock(blockId)!;
    const isImage = block.type === IMAGE_BLOCK_TYPE;

    const [requestedTab, setRequestedTab] = useState<"upload" | "embed">("upload");
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
