import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { BlockNoteEditor, getNodeById } from "@blocknote/core";
import { AI_SSE_EVENTS, type AiActionDto, type NoteDto } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { AiSessionProvider } from "@/components/ai/AiSession";
import { NoteEditorView } from "@/components/NoteEditor";
import { Toaster } from "@/components/ui/toast";
import { ThemeProvider } from "@/theme";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * #263 AI 框測試的共用 Host（spec §7；memory knotebook-review-probe-fidelity-lessons）：照 `NoteEditor.tsx` 的真實掛載鏈——
 * `AiSessionProvider`（:450）包 `NoteEditorView`（:476），AI 元件是 `<BlockNoteView>` 的 children（:561-585），`editor.portalElement`
 * 由 BlockNoteView 掛上。外層 `MemoryRouter`＋`QueryClientProvider`：wikilink inline 用到 `useNavigate`／`useNotes`；`ThemeProvider`：預覽的 `DiffEditor` 用到 `useTheme`。
 * 不是 `NoteEditor` 本體——`NoteEditor` 自己 `useCreateBlockNote` 建 editor，測試拿不到實例去設選取。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
export type AnyEditor = BlockNoteEditor<any, any, any>;

export function createTestEditor(initialContent: unknown[]): AnyEditor {
  return BlockNoteEditor.create({ schema: noteSchema, initialContent: initialContent as never }) as AnyEditor;
}

export interface AiRequestBody {
  action_id: string;
  note_id: string;
  text: string;
  instruction?: string;
  focus?: string;
}

/** 一次 `POST /api/ai` 的把手：測試可在任意時間點推 delta、收尾或丟錯。 */
export interface AiCall {
  body: AiRequestBody;
  signal: AbortSignal;
  delta(text: string): void;
  done(): void;
  fail(code: string): void;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), body: null } as unknown as Response;
}

/** 假 fetch：`GET /api/ai/actions`、`GET /api/notes` 回固定值；`POST /api/ai` 開一條等測試推事件的串流。 */
export function stubAiFetch(opts: { actions: AiActionDto[]; notes?: NoteDto[] }): { calls: AiCall[] } {
  const calls: AiCall[] = [];
  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(jsonResponse(200, { actions: opts.actions }));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(jsonResponse(200, opts.notes ?? []));
      if (url === "/api/ai" && method === "POST") {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        const frame = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        calls.push({
          body: JSON.parse(String(init?.body)) as AiRequestBody,
          signal: init?.signal as AbortSignal,
          delta: (text) => frame(AI_SSE_EVENTS.delta, { text }),
          done: () => {
            frame(AI_SSE_EVENTS.done, {});
            controller.close();
          },
          fail: (code) => {
            frame(AI_SSE_EVENTS.error, { code, message: "test failure" });
            controller.close();
          },
        });
        return Promise.resolve({ ok: true, status: 200, body: stream, json: () => Promise.reject(new Error("stream")) } as unknown as Response);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return { calls };
}

export interface AiHostProps {
  editor: AnyEditor;
  noteId?: string;
  editable?: boolean;
  onAutoClose?: () => void;
  children?: ReactNode;
}

async function noItems(): Promise<never[]> {
  return [];
}

export function renderAiHost(props: AiHostProps) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (p: AiHostProps) => (
    <MemoryRouter>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AiSessionProvider editor={p.editor} noteId={p.noteId ?? "note-1"} editable={p.editable ?? true} onAutoClose={p.onAutoClose}>
            <NoteEditorView
              editor={p.editor}
              editable={p.editable ?? true}
              theme="light"
              noteId={p.noteId ?? "note-1"}
              getItems={noItems}
              getSlashItems={noItems}
            >
              {p.children}
            </NoteEditorView>
          </AiSessionProvider>
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
  const result = render(tree(props));
  return { ...result, queryClient, rerenderHost: (overrides: Partial<AiHostProps>) => result.rerender(tree({ ...props, ...overrides })) };
}

/** 區塊內文的起點（`blockContainer` 的 posBefore＋2，探針實測）。 */
export function contentStart(editor: AnyEditor, blockId: string): number {
  const info = getNodeById(blockId, editor.prosemirrorState.doc);
  if (!info) throw new Error(`找不到區塊 ${blockId}`);
  return info.posBeforeNode + 2;
}

export function contentEnd(editor: AnyEditor, blockId: string): number {
  const info = getNodeById(blockId, editor.prosemirrorState.doc);
  if (!info) throw new Error(`找不到區塊 ${blockId}`);
  return info.posBeforeNode + 2 + (info.node.firstChild?.content.size ?? 0);
}

export function selectText(editor: AnyEditor, from: number, to: number): void {
  act(() => {
    editor._tiptapEditor.commands.setTextSelection({ from, to });
  });
}

export function selectInBlock(editor: AnyEditor, blockId: string, start: number, end: number): void {
  const base = contentStart(editor, blockId);
  selectText(editor, base + start, base + end);
}

export function selectWholeBlocks(editor: AnyEditor, firstId: string, lastId: string): void {
  selectText(editor, contentStart(editor, firstId), contentEnd(editor, lastId));
}

export function placeCursor(editor: AnyEditor, blockId: string, offset: number): void {
  const pos = contentStart(editor, blockId) + offset;
  selectText(editor, pos, pos);
}
