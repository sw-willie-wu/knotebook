import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { BLOCKED_MEDIA_URL } from "@/lib/media-url";
import { blocknoteZhTW } from "@/i18n/blocknote-zh-TW";
import { noteSchema } from "./schema";
import { buildReadonlyNoteEditorOptions } from "./editor-options";
import type { PublicNoteRef } from "@/lib/public-note-ref";

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

function build(language = "en", publicRef: PublicNoteRef = { kind: "token", token: TOKEN }) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  return { doc, awareness, options: buildReadonlyNoteEditorOptions({ doc, awareness, publicRef, language }) };
}

describe("buildReadonlyNoteEditorOptions (#72, #122: editor options for both public read-only page forms)", () => {
  it("fragment is shared's YDOC_FRAGMENT itself (a wrong name shows up as a blank page with zero errors, as warned at the top of store.ts)", () => {
    const { doc, options } = build();
    expect(options.collaboration.fragment).toBe(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(options.collaboration.fragment).not.toBe(doc.getXmlFragment("default"));
  });

  it("schema is noteSchema itself (the read-only page renders the same content shapes as the edit page)", () => {
    const { options } = build();
    expect(options.schema).toBe(noteSchema);
  });

  it("provider is a bare { awareness } object holding the local Awareness passed in (no HocuspocusProvider)", () => {
    const { awareness, options } = build();
    expect(options.collaboration.provider).toEqual({ awareness });
    expect(options.collaboration.provider.awareness).toBe(awareness);
  });

  it("collaboration.user is an anonymous stand-in (name/color are required: withCollaboration breaks without a user; read-only shows no cursors, so the values don't matter)", () => {
    const { options } = build();
    expect(typeof options.collaboration.user.name).toBe("string");
    expect(typeof options.collaboration.user.color).toBe("string");
    expect(options.collaboration.user.color.length).toBeGreaterThan(0);
  });

  it("language starting with zh -> Traditional Chinese dictionary; otherwise undefined (same rule as the edit page, shared underneath so the two sides don't each write one)", () => {
    expect(build("zh-TW").options.dictionary).toBe(blocknoteZhTW);
    expect(build("en").options.dictionary).toBeUndefined();
  });

  it("resolveFileUrl goes through publicMediaUrl: own uploads map to the public image endpoint, dangerous schemes are still blocked by the #12 guard", async () => {
    const { options } = build();
    await expect(options.resolveFileUrl!("/api/uploads/abc")).resolves.toBe(
      `/api/public/notes/${TOKEN}/uploads/abc`,
    );
    await expect(options.resolveFileUrl!("javascript:alert(1)")).resolves.toBe(BLOCKED_MEDIA_URL);
  });

  it("resolveFileUrl alias form (#122): maps to the by-path image endpoint via publicRef", async () => {
    const { options } = build("en", { kind: "path", handle: "alice", slug: "my-doc" });
    await expect(options.resolveFileUrl!("/api/uploads/abc")).resolves.toBe(
      "/api/public/notes/alice/my-doc/uploads/abc",
    );
  });

  it("no editing options attached: uploadFile / pasteHandler / _tiptapOptions are all absent (the read-only page has no input path, so attaching them would be attack surface)", () => {
    const keys = Object.keys(build().options);
    expect(keys).not.toContain("uploadFile");
    expect(keys).not.toContain("pasteHandler");
    expect(keys).not.toContain("_tiptapOptions");
  });

  // #99: the public read-only page must not get the markdown link input rule (nor the `/` menu). That lives on `_tiptapOptions.extensions`; the "keys don't include _tiptapOptions" test above already implies it, and this separate assertion makes what the guard requires visible in the source without the reader deriving "no _tiptapOptions => no extensions".
  it("read-only options don't include _tiptapOptions (the public page must not get input rules or the / menu)", () => {
    expect(build().options).not.toHaveProperty("_tiptapOptions");
  });
});

describe("public read-only page: uploaded audio, video and files", () => {
  it("audio and video play from the public endpoint, and the file block's name links there (new tab, no download attribute)", async () => {
    const { doc, options } = build();
    const seed = BlockNoteEditor.create({ schema: noteSchema });
    blocksToYXmlFragment(
      seed,
      [
        { id: "a1", type: "audio", props: { url: "/api/uploads/a1", name: "talk.m4a" } },
        { id: "v1", type: "video", props: { url: "/api/uploads/v1", name: "clip.mp4" } },
        { id: "f1", type: "file", props: { url: "/api/uploads/f1", name: "quote.pdf" } },
      ] as never,
      doc.getXmlFragment(YDOC_FRAGMENT),
    );
    const editor = BlockNoteEditor.create(options);
    const el = document.createElement("div");
    document.body.append(el);
    editor.mount(el);
    try {
      const base = `/api/public/notes/${TOKEN}/uploads`;
      await vi.waitFor(() => {
        expect(el.querySelector("audio")?.getAttribute("src")).toBe(`${base}/a1`);
        expect(el.querySelector("video")?.getAttribute("src")).toBe(`${base}/v1`);
        expect(el.querySelector('[data-id="f1"] .bn-file-name a')?.getAttribute("href")).toBe(`${base}/f1`);
      });
      const link = el.querySelector<HTMLAnchorElement>('[data-id="f1"] .bn-file-name a')!;
      expect(link.target).toBe("_blank");
      expect(link.hasAttribute("download")).toBe(false);
      expect(link.textContent).toBe("quote.pdf");
    } finally {
      editor.unmount();
      el.remove();
    }
  });
});
