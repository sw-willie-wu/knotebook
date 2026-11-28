// Deliberate: TrashPreviewPage must not rely on NoteEditor being loaded for BlockNote styles.
import "@blocknote/mantine/style.css";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { buildNoteEditorOptionsBase } from "@/collab/editor-options";
import { MediaZoomContext } from "@/components/media-zoom/context";
import { ARTICLE_TEXT_INSET } from "@/components/ui/article-column";
import { trashMediaUrl } from "@/lib/trash-media-url";
import { ydocBytesToBlocks } from "@/lib/version-snapshot";
import { useTheme } from "@/theme";

type BlockLike = { type?: string; content?: unknown; children?: unknown[] };

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function isEmptyBlocks(blocks: readonly BlockLike[]): boolean {
  if (blocks.length === 0) return true;
  return blocks.every((b) => {
    if (b.type !== "paragraph") return false;
    if (Array.isArray(b.children) && b.children.length > 0) return false;
    if (b.content === undefined || b.content === null) return true;
    if (typeof b.content === "string") return b.content.length === 0;
    return Array.isArray(b.content) && b.content.length === 0;
  });
}

function ReadonlyBlocksView({ noteId, blocks }: { noteId: string; blocks: readonly BlockLike[] }) {
  const { i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const resolveUrl = useMemo(() => trashMediaUrl(noteId), [noteId]);
  const editor = useCreateBlockNote(
    {
      ...buildNoteEditorOptionsBase(i18n.language),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PartialBlock generic triple (repo convention)
      initialContent: blocks as any,
      resolveFileUrl: (url: string) => Promise.resolve(resolveUrl(url)),
    },
    [blocks, resolveUrl],
  );
  return (
    <MediaZoomContext.Provider value={null}>
      <BlockNoteView editor={editor} editable={false} theme={resolvedTheme} data-testid="trash-preview-editor" />
    </MediaZoomContext.Provider>
  );
}

/** Read-only BlockNote renderer for a trashed note's Yjs snapshot. Never connects to Hocuspocus or mounts collaboration. */
export function TrashPreviewEditor({ noteId, ydoc }: { noteId: string; ydoc: string }) {
  const { t } = useTranslation();
  const decoded = useMemo<
    { ok: true; blocks: BlockLike[] } | { ok: false }
  >(() => {
    try {
      const blocks = ydocBytesToBlocks(decodeBase64(ydoc)) as unknown as BlockLike[];
      return { ok: true, blocks };
    } catch {
      return { ok: false };
    }
  }, [ydoc]);

  if (!decoded.ok) {
    return (
      <p role="alert" className={`${ARTICLE_TEXT_INSET} text-sm text-destructive`}>
        {t("trash.previewDecodeFailed")}
      </p>
    );
  }
  if (isEmptyBlocks(decoded.blocks)) {
    return <p className={`${ARTICLE_TEXT_INSET} text-sm text-muted-foreground`}>{t("trash.previewEmpty")}</p>;
  }
  return <ReadonlyBlocksView noteId={noteId} blocks={decoded.blocks} />;
}
