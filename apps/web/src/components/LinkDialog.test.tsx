/**
 * `/` 選單「連結」項的插入對話框（issue #99，design §6／§6.1）。
 *
 * 主要行為（送出/取消/驗證/a11y）用**未掛進 DOM**的真 `BlockNoteEditor`
 * （`BlockNoteEditor.create({ schema: noteSchema })`，同 `markdown-link.test.ts` 的
 * 既有慣例）——網址驗證共用 `resolveTrailingMarkdownLink`，那支要吃真的
 * `tryParseMarkdownToBlocks`，假 editor 只會測到我們自己的 mock 行為。這批測試裡
 * `open` 恆為 `true`（`onOpenChange` 只是 spy，不接回 state），Dialog 不會真的
 * unmount，`editor.focus()`（掛在 `onCloseAutoFocus`）不會被呼叫，不必 stub 它。
 *
 * 焦點回歸（fix round 1 Important 1）另開一個 describe，**掛真 DOM**
 * （`editor.mount(container)`，同 `NoteEditorView.test.tsx` 的 `mountedEditor()`
 * 既有慣例）＋一個持有 `open` state 的 controlled wrapper，讓 Dialog 真的會
 * unmount——只斷言 spy 被呼叫過**不是結果**，這裡改斷言 `document.activeElement`
 * 真的落在編輯器的 `.ProseMirror` 節點上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { BlockNoteEditor } from "@blocknote/core";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { LinkDialog } from "./LinkDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
let editor: BlockNoteEditor<any, any, any>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  editor = BlockNoteEditor.create({ schema: noteSchema }) as BlockNoteEditor<any, any, any>;
});

function renderDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (v: { text: string; href: string }) => void }) {
  return render(
    <I18nextProvider i18n={i18n}>
      <LinkDialog editor={editor} {...props} />
    </I18nextProvider>,
  );
}

describe("LinkDialog", () => {
  it("填文字＋合法網址 → onSubmit 收到 { text, href }", () => {
    const onSubmit = vi.fn();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit });

    fireEvent.change(screen.getByLabelText(i18n.t("note.link.textLabel")), { target: { value: "我的連結" } });
    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    expect(onSubmit).toHaveBeenCalledWith({ text: "我的連結", href: "https://example.com" });
  });

  it("網址不合法（javascript: scheme）→ 不呼叫 onSubmit，畫面出現 invalidUrl 錯誤", () => {
    const onSubmit = vi.fn();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit });

    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(i18n.t("note.link.invalidUrl"))).toBeInTheDocument();
  });

  it("取消 → 不呼叫 onSubmit", () => {
    const onSubmit = vi.fn();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit });

    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("home.cancel") }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("顯示文字留空＋合法網址 → onSubmit 收到 text === href（D15 的 fallback）", () => {
    const onSubmit = vi.fn();
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit });

    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    expect(onSubmit).toHaveBeenCalledWith({ text: "https://example.com", href: "https://example.com" });
  });

  it("無障礙：兩欄各有 <label for> 綁定、錯誤訊息用 aria-describedby 綁到網址欄", () => {
    renderDialog({ open: true, onOpenChange: vi.fn(), onSubmit: vi.fn() });

    const textInput = screen.getByLabelText(i18n.t("note.link.textLabel"));
    const urlInput = screen.getByLabelText(i18n.t("note.link.urlLabel"));
    expect(textInput.tagName).toBe("INPUT");
    expect(urlInput.tagName).toBe("INPUT");
    // useId 生成的 id 不寫死，但兩欄各自的 id 仍要彼此不同——否則 <label for> 會撞名。
    expect(textInput.id).not.toBe(urlInput.id);

    fireEvent.change(urlInput, { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    const error = screen.getByText(i18n.t("note.link.invalidUrl"));
    expect(urlInput).toHaveAttribute("aria-describedby", error.id);
  });
});

/**
 * 焦點回歸（fix round 1 Important 1）：舊版本只斷言 `editor.focus` 這個 spy 被呼叫
 * 一次，沒斷言真的有沒有生效——實測（掛真編輯器＋真元件、不 stub `.focus`）三條關閉
 * 路徑全部失敗（`document.activeElement` 停在 `<body>`）。改成 `onCloseAutoFocus`
 * 之後這裡直接量真實結果，不再信任 spy。
 */
describe("LinkDialog — 焦點回歸（真編輯器，掛進 DOM）", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  /** `Dialog` 是 controlled component——要讓它真的 unmount（觸發 `onCloseAutoFocus`），
   * 測試這一層要自己接住 `onOpenChange` 更新 state，不能像上面那組一樣傳固定 `open`。 */
  function ControlledLinkDialog({ onSubmit }: { onSubmit: (v: { text: string; href: string }) => void }) {
    const [open, setOpen] = useState(true);
    return <LinkDialog editor={editor} open={open} onOpenChange={setOpen} onSubmit={onSubmit} />;
  }

  function renderControlled(onSubmit: (v: { text: string; href: string }) => void) {
    return render(
      <I18nextProvider i18n={i18n}>
        <ControlledLinkDialog onSubmit={onSubmit} />
      </I18nextProvider>,
    );
  }

  /** 焦點是否落在編輯器的 ProseMirror 根節點——不是「onOpenChange/focus 被呼叫過」。 */
  function editorIsFocused(): boolean {
    return document.activeElement?.classList.contains("ProseMirror") === true;
  }

  it("送出成功後：焦點回到編輯器", async () => {
    renderControlled(vi.fn());
    fireEvent.change(screen.getByLabelText(i18n.t("note.link.urlLabel")), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("note.link.insert") }));

    await waitFor(() => expect(editorIsFocused()).toBe(true));
  });

  it("取消後：焦點回到編輯器（只測送出那條接不住這個）", async () => {
    renderControlled(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: i18n.t("home.cancel") }));

    await waitFor(() => expect(editorIsFocused()).toBe(true));
  });

  it("按 Esc 關閉後：焦點回到編輯器（不是只有送出/取消鈕兩條路徑）", async () => {
    renderControlled(vi.fn());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => expect(editorIsFocused()).toBe(true));
  });
});
