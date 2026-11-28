import "@/i18n/upload-block-strings";
import { useCallback, useState, type ChangeEvent, type FC, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { FilePanelExtension, filenameFromURL } from "@blocknote/core";
import { useBlockNoteEditor, type FilePanelProps } from "@blocknote/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isAllowedEmbedUrl } from "@/lib/media-url";
import { precheckMessage, type PrecheckCtx } from "@/uploads/precheck";
import { startUpload } from "@/uploads/upload-runner";

const INPUT_LABEL_KEYS: Record<string, string> = {
  image: "note.filePanel.upload.inputLabel",
  audio: "uploadBlock.pickAudio",
  video: "uploadBlock.pickVideo",
  file: "uploadBlock.pickFile",
};

/**
 * Not `editor.uploadFile`: BlockNote's own Upload tab calls it for a block the person already has, possibly holding a
 * file (replace-file flow). The upload expects the block's current URL, so a file someone else put there meanwhile
 * isn't overwritten; a pre-check refusal is shown here and the block is left alone.
 */
function UploadTab({ noteId, blockId, precheckCtx }: { noteId: string; blockId: string; precheckCtx: () => Promise<PrecheckCtx> }) {
  const { t } = useTranslation();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any (as in wikilink/menu.ts)
  const editor = useBlockNoteEditor<any, any, any>();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const block = editor.getBlock(blockId);
  const blockType: string = block?.type ?? "file";
  const accept: readonly string[] = editor.schema.blockSpecs[blockType]?.implementation.meta?.fileBlockAccept ?? [];

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Clear the value so choosing the same file again after a refusal fires `onChange`.
      event.target.value = "";
      if (!file) {
        return;
      }
      if (!editor.getBlock(blockId)) {
        return;
      }
      setError(null);
      setChecking(true);
      // Read after the check: an earlier upload may have written its file into this block in the meantime.
      const expectedUrl = () => (editor.getBlock(blockId)?.props as { url?: string } | undefined)?.url ?? "";
      void startUpload({ noteId, blockId, file, expectedUrl, precheckCtx, recordRefusal: false }).then(
        (started) => {
          setChecking(false);
          if (!started.ok) {
            setError(precheckMessage(file, started.result, t));
            return;
          }
          // The block shows the progress from here on.
          editor.getExtension(FilePanelExtension)?.closeMenu();
        },
      );
    },
    [noteId, blockId, editor, t, precheckCtx],
  );

  return (
    <div className="space-y-2 p-3">
      <label htmlFor={`filepanel-upload-${blockId}`} className="block text-xs font-medium text-muted-foreground">
        {t(INPUT_LABEL_KEYS[blockType] ?? INPUT_LABEL_KEYS.file!)}
      </label>
      <Input
        id={`filepanel-upload-${blockId}`}
        type="file"
        accept={accept.join(",")}
        disabled={checking}
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

/**
 * Must be `useMemo`d by the caller and rebuilt only when `noteId` changes: each call returns a new component type, which `FilePanelController` would unmount and remount (wiping a half-typed URL).
 * `precheckCtx` is read at each pick, so a getter that follows the page's latest provider keeps the panel mounted.
 */
export function createFilePanel(noteId: string, precheckCtx: () => Promise<PrecheckCtx>): FC<FilePanelProps> {
  return function MyFilePanel({ blockId }: FilePanelProps) {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<"upload" | "embed">("upload");

    return (
      <div className="w-72 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
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
            onClick={() => setActiveTab("upload")}
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
            onClick={() => setActiveTab("embed")}
          >
            {t("note.filePanel.embed.tabLabel")}
          </button>
        </div>
        {activeTab === "upload" ? <UploadTab noteId={noteId} blockId={blockId} precheckCtx={precheckCtx} /> : <EmbedTab blockId={blockId} />}
      </div>
    );
  };
}
