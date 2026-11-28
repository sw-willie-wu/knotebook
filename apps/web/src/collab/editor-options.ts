import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { blocknoteZhTW } from "@/i18n/blocknote-zh-TW";
import { publicMediaUrl } from "@/lib/public-media-url";
import type { PublicNoteRef } from "@/lib/public-note-ref";

// Schema, dictionary and collaboration must match on the edit and read-only pages: a wrong fragment name = blank page with no error; different schemas = the same note renders differently.
export interface CollabEditorBaseInput {
  doc: Y.Doc;
  awareness: Awareness | undefined;
  language: string;
  user: { id?: string; name: string; color: string };
}

// Tests that build an editor use this too, so it can't diverge from the real settings.
export const NOTE_TABLE_SETTINGS = { cellTextColor: true, cellBackgroundColor: true } as const;

export function buildNoteEditorOptionsBase(language: string) {
  return {
    schema: noteSchema,
    tables: NOTE_TABLE_SETTINGS,
    dictionary: language.startsWith("zh") ? blocknoteZhTW : undefined,
  };
}

export function buildCollabEditorBase({ doc, awareness, language, user }: CollabEditorBaseInput) {
  return {
    ...buildNoteEditorOptionsBase(language),
    collaboration: {
      // BlockNote's collaboration.provider only reads { awareness }.
      provider: { awareness },
      // Same name as the server's `collab/store.ts`; a hard-coded string on either side gives two unrelated documents (looks like "sync is broken").
      fragment: doc.getXmlFragment(YDOC_FRAGMENT),
      user,
    },
  };
}

export interface ReadonlyNoteEditorOptionsInput {
  doc: Y.Doc;
  awareness: Awareness;
  publicRef: PublicNoteRef;
  language: string;
}

// Anonymous visitors have no session, so `/api/uploads/:id` would 401: `resolveFileUrl` is {@link publicMediaUrl}. No editing options are attached: a read-only page has no input path, so they'd only add attack surface.
// `editable={false}` comes from PublicNoteEditor's BlockNoteView.
export function buildReadonlyNoteEditorOptions({ doc, awareness, publicRef, language }: ReadonlyNoteEditorOptionsInput) {
  const resolvePublicUrl = publicMediaUrl(publicRef);
  return withCollaboration({
    ...buildCollabEditorBase({
      doc,
      awareness,
      language,
      // Anonymous stand-in: required, but no cursor name tag is rendered when read-only.
      user: { name: "", color: "#888888" },
    }),
    resolveFileUrl: (url: string) => Promise.resolve(resolvePublicUrl(url)),
  });
}
