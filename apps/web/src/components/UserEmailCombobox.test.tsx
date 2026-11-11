import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, useState, type RefObject } from "react";
import type { UserSuggestionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { UserEmailCombobox } from "./UserEmailCombobox";

const ANN: UserSuggestionDto = { userId: "u-ann", email: "ann@example.com", displayName: "Ann Example" };
const ANDY: UserSuggestionDto = { userId: "u-andy", email: "andy@example.com", displayName: "Andy Example" };

function suggestFetch(users: UserSuggestionDto[] = [ANN, ANDY]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/users/suggest?")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ users }) } as unknown as Response);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Harness({ onSubmit, exclude, inDialog = false }: { onSubmit: (email: string) => void; exclude?: string[]; inDialog?: boolean }) {
  const [value, setValue] = useState("");
  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <UserEmailCombobox label="Email address" value={value} onChange={setValue} excludeUserIds={exclude} />
      <button type="submit">Add</button>
    </form>
  );
  if (!inDialog) return form;
  return (
    <Dialog open onOpenChange={() => onSubmit("__dialog_closed__")}>
      <DialogContent>
        <DialogTitle>Dialog</DialogTitle>
        <DialogDescription>desc</DialogDescription>
        {form}
      </DialogContent>
    </Dialog>
  );
}

/** 預設 harness 關 retry；要守 `useUserSuggestions` 自己的 `retry: false` 的案傳 `new QueryClient()`（不關 retry）進來。 */
function renderHarness(
  props: Parameters<typeof Harness>[0],
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

function input(): HTMLInputElement {
  return screen.getByRole("combobox", { name: "Email address" }) as HTMLInputElement;
}

async function typeAndWaitForList(text: string): Promise<HTMLElement> {
  fireEvent.change(input(), { target: { value: text } });
  return screen.findByRole("listbox", { name: "People you know" });
}

describe("UserEmailCombobox", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("≥ 2 字、debounce 之後才查；清單列顯示名稱＋email；ARIA 狀態", async () => {
    const fetchMock = suggestFetch();
    renderHarness({ onSubmit: vi.fn() });
    expect(input()).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(input(), { target: { value: "a" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).not.toHaveBeenCalled();

    const list = await typeAndWaitForList("an");
    expect(fetchMock).toHaveBeenCalledWith("/api/users/suggest?q=an", expect.anything());
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Ann Exampleann@example.com", "Andy Exampleandy@example.com"]);
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(input()).toHaveAttribute("aria-controls", list.id);
    expect(input()).not.toHaveAttribute("aria-activedescendant");
  });

  it("鍵盤：↓／↑ 移動（循環）、Enter 選取填入 email 且不送出表單", async () => {
    suggestFetch();
    const onSubmit = vi.fn();
    renderHarness({ onSubmit });
    const list = await typeAndWaitForList("an");
    const [first, second] = within(list).getAllByRole("option");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", first!.id);
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", second!.id);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", first!.id);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(input()).toHaveAttribute("aria-activedescendant", second!.id);

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("andy@example.com");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(onSubmit).not.toHaveBeenCalled();

    // 選完再按 Enter（沒有選中項目）→ 照常送出表單
    fireEvent.submit(input().form!);
    expect(onSubmit).toHaveBeenCalledWith("andy@example.com");
  });

  it("點選項目填入 email", async () => {
    suggestFetch();
    renderHarness({ onSubmit: vi.fn() });
    const list = await typeAndWaitForList("an");
    const option = within(list).getByRole("option", { name: /Ann Example/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(input()).toHaveValue("ann@example.com");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("沒有選中項目時 Enter 不攔：打的完整 email 照樣送出", async () => {
    suggestFetch([]);
    const onSubmit = vi.fn();
    renderHarness({ onSubmit });
    fireEvent.change(input(), { target: { value: "someone@example.com" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.submit(input().form!);
    expect(onSubmit).toHaveBeenCalledWith("someone@example.com");
  });

  it("Esc 收起清單，但不關掉外層 Dialog", async () => {
    suggestFetch();
    const onSubmit = vi.fn();
    renderHarness({ onSubmit, inDialog: true });
    await typeAndWaitForList("an");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    // 清單已收起時 Esc 照常交給 Dialog
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onSubmit).toHaveBeenCalledWith("__dialog_closed__");
  });

  it("excludeUserIds 裡的人不出現", async () => {
    suggestFetch();
    renderHarness({ onSubmit: vi.fn(), exclude: [ANN.userId] });
    const list = await typeAndWaitForList("an");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Andy Exampleandy@example.com"]);
  });

  it("查詢失敗 → 沒有清單，輸入框照常可用；不重試（恰打一次）", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({ error: { code: "too_many_requests", message: "x" } }) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    // 這一案刻意用**不關 retry** 的 QueryClient：守的是 `useUserSuggestions` 自己的 `retry: false`（被節流了還重試
    // 只會更糟）。元件不顯示錯誤，所以等查詢本身進 error 態；拿掉 `retry: false` 的話 query-core 預設重試 3 次
    //（退避約 7 秒，塞得進全域等待上限），進 error 態時已打 4 次 → 計次紅。
    const queryClient = new QueryClient();
    renderHarness({ onSubmit: vi.fn() }, queryClient);
    fireEvent.change(input(), { target: { value: "an" } });
    // 掛載時空字串那支（enabled false）也在快取裡、恆 pending，所以找「有任何一支進了 error」。
    const anyErrored = () => queryClient.getQueryCache().findAll({ queryKey: ["userSuggest"] }).some((q) => q.state.status === "error");
    await waitFor(() => expect(anyErrored()).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveValue("an");
  });
});

/**
 * 群組加成員那格（#331 收多個地址）：`multiple`；`locked` 勾起來＝批次加入跑的期間（readOnly）。
 * `pasteAs`：比照 #331 的 handlePaste——擋掉預設貼上、在外層直接改值（不經過 onChange）。
 */
function MultiHarness({ inputRef, pasteAs }: { inputRef?: RefObject<HTMLInputElement | null>; pasteAs?: string }) {
  const [value, setValue] = useState("");
  const [locked, setLocked] = useState(false);
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <UserEmailCombobox
        ref={inputRef}
        multiple
        readOnly={locked}
        label="Email address"
        value={value}
        onChange={setValue}
        onPaste={
          pasteAs === undefined
            ? undefined
            : (event) => {
                event.preventDefault();
                setValue(pasteAs);
              }
        }
      />
      <label>
        <input type="checkbox" checked={locked} onChange={(event) => setLocked(event.target.checked)} />
        Lock
      </label>
    </form>
  );
}

function renderMulti(props: Parameters<typeof MultiHarness>[0] = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MultiHarness {...props} />
    </QueryClientProvider>,
  );
}

/** 打字：值與游標一起換（游標預設在最後）。 */
function typeAt(text: string, caret = text.length): void {
  fireEvent.change(input(), { target: { value: text, selectionStart: caret, selectionEnd: caret } });
}

describe("UserEmailCombobox multiple（群組加成員的多地址框）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("text＋inputMode email（不是 type=email：原生驗證會擋多個地址）；ref 指向輸入框", () => {
    suggestFetch();
    const ref = createRef<HTMLInputElement>();
    renderMulti({ inputRef: ref });
    expect(input()).toHaveAttribute("type", "text");
    expect(input()).toHaveAttribute("inputmode", "email");
    expect(ref.current).toBe(input());
  });

  it("改中間那個地址：只拿游標所在的地址去查；選取只換那一個、不多補分隔，游標放在分隔後面", async () => {
    const fetchMock = suggestFetch();
    renderMulti();
    typeAt("a@x.com, an, c@y.com", "a@x.com, an".length);
    const list = await screen.findByRole("listbox", { name: "People you know" });
    expect(fetchMock).toHaveBeenCalledWith("/api/users/suggest?q=an", expect.anything());
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["/api/users/suggest?q=an"]);
    const option = within(list).getByRole("option", { name: /Ann Example/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(input()).toHaveValue("a@x.com, ann@example.com, c@y.com");
    expect(input().selectionStart).toBe("a@x.com, ann@example.com, ".length);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("全形分隔（，；、與全形空白）也算邊界；在最後一個地址選取 → 補「, 」，其他地址原樣不動", async () => {
    const fetchMock = suggestFetch();
    renderMulti();
    typeAt("a@x.com，b@y.com；c@z.com、d@w.com　an");
    await screen.findByRole("listbox", { name: "People you know" });
    expect(fetchMock).toHaveBeenCalledWith("/api/users/suggest?q=an", expect.anything());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("a@x.com，b@y.com；c@z.com、d@w.com　ann@example.com, ");
    expect(input().selectionStart).toBe(input().value.length);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("選完接著打下一個：查的是新打的那一段，框裡已有的地址不再建議（不分大小寫）", async () => {
    const fetchMock = suggestFetch();
    renderMulti();
    typeAt("ANN@example.com, an");
    const list = await screen.findByRole("listbox", { name: "People you know" });
    expect(fetchMock).toHaveBeenCalledWith("/api/users/suggest?q=an", expect.anything());
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Andy Exampleandy@example.com"]);
  });

  it("游標在分隔上（前後都不是地址）→ 不查、不開清單", async () => {
    const fetchMock = suggestFetch();
    renderMulti();
    typeAt("ann@example.com, ");
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("readOnly（批次加入跑的期間）：開著的清單收起，↓ 不開、改值也不開，不能選取", async () => {
    suggestFetch();
    renderMulti();
    typeAt("a@x.com, an");
    await screen.findByRole("listbox", { name: "People you know" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Lock" }));
    expect(input()).toHaveAttribute("readonly");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    typeAt("a@x.com, and");
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("a@x.com, and");
  });

  it("游標移到另一個地址 → 舊地址的清單收起，Enter 不會換掉游標所在的地址", async () => {
    suggestFetch();
    renderMulti();
    // React 的 onSelect 要先看到 focusin（記下作用中的輸入框），之後 mouseup／keyup 時比對選取範圍有沒有變
    input().focus();
    fireEvent.focusIn(input());
    typeAt("bob@example.com, an");
    await screen.findByRole("listbox", { name: "People you know" });
    // 點一下把游標放進 bob 那個地址（用 mouseup：前面的測試按過選項的 mousedown，React 要等 mouseup 才再算選取）
    input().setSelectionRange(2, 2);
    fireEvent.mouseUp(input());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("bob@example.com, an");
  });

  it("外層接手的貼上（擋掉預設、直接改值）→ 清單收起", async () => {
    suggestFetch();
    renderMulti({ pasteAs: "a@x.com, b@y.com" });
    typeAt("an");
    await screen.findByRole("listbox", { name: "People you know" });
    fireEvent.paste(input(), { clipboardData: { getData: () => "a@x.com\nb@y.com" } });
    expect(input()).toHaveValue("a@x.com, b@y.com");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("選取後值沒變（選的就是打完整的那個、後面已有分隔）→ 游標放到分隔後；接著打字游標不會被拉回去", async () => {
    suggestFetch();
    renderMulti();
    typeAt("ann@example.com, c@y.com", 2);
    const list = await screen.findByRole("listbox", { name: "People you know" });
    const option = within(list).getByRole("option", { name: /Ann Example/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(input()).toHaveValue("ann@example.com, c@y.com");
    expect(input().selectionStart).toBe("ann@example.com, ".length);
    typeAt("ann@example.com, c@y.comx");
    expect(input().selectionStart).toBe("ann@example.com, c@y.comx".length);
  });

  it("輸入法選字中的 Enter 不選取（交給輸入法）", async () => {
    suggestFetch();
    renderMulti();
    typeAt("an");
    await screen.findByRole("listbox", { name: "People you know" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(input()).toHaveValue("an");
    expect(screen.getByRole("listbox", { name: "People you know" })).toBeInTheDocument();
  });
});
