import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { formatBytes, type AvatarCandidateDto, type AvatarListDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { settle } from "@/test/outside-click";
import { AvatarSection } from "./AvatarSection";

// 裁切框本身另有測試；這裡只驗「什麼時候、帶什麼來源開它」。
vi.mock("./AvatarCropDialog", () => ({
  AvatarCropDialog: ({ source, onOpenChange }: { source: { kind: string; file?: File; candidate?: { id: string } }; onOpenChange: (open: boolean) => void }) => (
    <div role="dialog" aria-label="Adjust picture" data-kind={source.kind} data-name={source.file?.name ?? source.candidate?.id}>
      <button type="button" onClick={() => onOpenChange(false)}>
        close-stub
      </button>
    </div>
  ),
}));

const ID_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID_B = "1a2b3c4d-d9cb-469f-a165-70867728950f";
const ID_C = "2b3c4d5e-d9cb-469f-a165-708677289510";

function candidate(id: string, over: Partial<AvatarCandidateDto> = {}): AvatarCandidateDto {
  return {
    id,
    source: "upload",
    providerName: null,
    avatar: { id, v: 1 },
    pending: false,
    current: false,
    crop: { x: 0, y: 0, size: 100 },
    originalWidth: 600,
    originalHeight: 400,
    originalSize: 3000,
    displaySize: 1000,
    createdAt: "2026-03-05T12:00:00.000Z",
    ...over,
  };
}

const USER: UserDto = {
  id: "u-alice",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const dateLabel = (iso: string) => new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "medium" });

interface Call {
  method: string;
  url: string;
  body: unknown;
}

interface Options {
  list?: AvatarListDto;
  listStatus?: number;
  maxUploadBytes?: number;
  respond?: (call: Call) => Response | undefined;
}

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

function setup(opts: Options = {}) {
  const list: AvatarListDto = opts.list ?? { candidates: [], auto: false, refreshable: [] };
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body };
      calls.push(call);
      const custom = opts.respond?.(call);
      if (custom) return custom;
      if (call.url === "/api/auth/me") return json(200, USER);
      if (call.url === "/api/auth/config") return json(200, { providers: [], maxUploadBytes: opts.maxUploadBytes });
      if (call.url === "/api/auth/avatars" && call.method === "GET") return json(opts.listStatus ?? 200, opts.listStatus === undefined ? list : { error: { code: "internal", message: "x" } });
      if (call.url === "/api/auth/avatar" && call.method === "PUT") return json(200, USER);
      if (call.url.startsWith("/api/auth/avatars/") && call.method === "DELETE") return json(204);
      throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AvatarSection />
      <Toaster />
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

const mutations = (calls: Call[]) => calls.filter(c => c.method !== "GET");
const listCalls = (calls: Call[]) => calls.filter(c => c.method === "GET" && c.url === "/api/auth/avatars");

const THREE: AvatarListDto = {
  candidates: [
    candidate(ID_A, { current: true, createdAt: "2026-03-05T12:00:00.000Z" }),
    candidate(ID_B, { createdAt: "2026-02-05T12:00:00.000Z" }),
    candidate(ID_C, { createdAt: "2026-01-05T12:00:00.000Z" }),
  ],
  auto: false,
  refreshable: [],
};

const radios = () => within(screen.getByRole("radiogroup", { name: "Picture options" })).getAllByRole("radio");
async function ready() {
  await screen.findByRole("radiogroup", { name: "Picture options" });
}
async function openMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0 });
  return screen.findByRole("menu");
}

describe("AvatarSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    cleanup();
    dismissAllToasts();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("候選格", () => {
    it("第一格「不使用頭貼」、其後候選依清單順序；目前那格 aria-checked，其餘不是", async () => {
      setup({ list: THREE });
      await ready();
      const cells = radios();
      expect(cells.map(c => c.getAttribute("aria-label"))).toEqual([
        "No picture",
        `Picture uploaded ${dateLabel("2026-03-05T12:00:00.000Z")}`,
        `Picture uploaded ${dateLabel("2026-02-05T12:00:00.000Z")}`,
        `Picture uploaded ${dateLabel("2026-01-05T12:00:00.000Z")}`,
      ]);
      expect(cells.map(c => c.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false"]);
    });

    it("沒有任何目前候選 →「不使用頭貼」那格是選中的", async () => {
      setup({ list: { ...THREE, candidates: THREE.candidates.map(c => ({ ...c, current: false })) } });
      await ready();
      expect(radios().map(c => c.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    });

    it("OIDC 來源的候選用登入服務名稱當格名", async () => {
      setup({ list: { candidates: [candidate(ID_A, { source: "oidc", providerName: "Corp SSO" })], auto: true, refreshable: [] } });
      await ready();
      expect(radios()[1]).toHaveAccessibleName("Picture from Corp SSO");
    });

    it("已解除連結的 OIDC 候選（providerName 為 null）不叫「上傳」", async () => {
      setup({ list: { candidates: [candidate(ID_A, { source: "oidc", providerName: null })], auto: true, refreshable: [] } });
      await ready();
      expect(radios()[1]).toHaveAccessibleName("Picture from a disconnected sign-in service");
    });

    it("同一天上傳的幾張，radio 與 ⋮ 的名稱各不相同（含時間）", async () => {
      setup({
        list: {
          candidates: [
            candidate(ID_A, { createdAt: "2026-03-05T12:00:00.000Z" }),
            candidate(ID_B, { createdAt: "2026-03-05T12:07:00.000Z" }),
          ],
          auto: false,
          refreshable: [],
        },
      });
      await ready();
      const names = radios().map(c => c.getAttribute("aria-label"));
      expect(new Set(names).size).toBe(3);
      const menus = screen.getAllByRole("button", { name: /^More actions for / }).map(b => b.getAttribute("aria-label"));
      expect(new Set(menus).size).toBe(2);
    });

    it("空清單：只有「不使用頭貼」一格，顯示空狀態與用量說明", async () => {
      setup();
      await ready();
      expect(radios()).toHaveLength(1);
      expect(screen.getByText("You haven't uploaded a picture yet.")).toBeInTheDocument();
      expect(screen.getByText("Profile pictures count toward your storage, original and cropped.")).toBeInTheDocument();
    });

    it("zh-TW 的格名與用量說明", async () => {
      await i18n.changeLanguage("zh-TW");
      setup({ list: THREE });
      await screen.findByRole("radiogroup", { name: "頭貼候選" });
      expect(screen.getByRole("radio", { name: "不使用頭貼" })).toBeInTheDocument();
      expect(screen.getByText("頭貼的原圖與裁切後的圖都會計入你的儲存空間。")).toBeInTheDocument();
    });

    it("載入中顯示載入文字；載入失敗顯示錯誤與重試，重試重抓清單", async () => {
      const { calls } = setup({ listStatus: 500 });
      expect(screen.getByText("Loading pictures…")).toBeInTheDocument();
      expect(await screen.findByText("Couldn't load your pictures.")).toBeInTheDocument();
      expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
      const before = listCalls(calls).length;
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(listCalls(calls).length).toBe(before + 1));
    });
  });

  describe("roving tabindex 與鍵盤", () => {
    it("只有目前那一格 tabIndex=0", async () => {
      setup({ list: THREE });
      await ready();
      expect(radios().map(c => c.tabIndex)).toEqual([-1, 0, -1, -1]);
    });

    it("左右鍵移動焦點與唯一的 tab 停靠點（不選用、不送請求）；到頭不循環", async () => {
      const { calls } = setup({ list: THREE });
      await ready();
      const cells = radios();
      cells[1]!.focus();
      fireEvent.keyDown(cells[1]!, { key: "ArrowRight" });
      expect(cells[2]).toHaveFocus();
      expect(radios().map(c => c.tabIndex)).toEqual([-1, -1, 0, -1]);
      fireEvent.keyDown(cells[2]!, { key: "ArrowLeft" });
      fireEvent.keyDown(cells[1]!, { key: "ArrowLeft" });
      expect(cells[0]).toHaveFocus();
      fireEvent.keyDown(cells[0]!, { key: "ArrowLeft" });
      expect(cells[0]).toHaveFocus();
      expect(cells.map(c => c.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false"]);
      expect(mutations(calls)).toHaveLength(0);
    });

    it("上下鍵與左右鍵同樣移動焦點，到頭不循環", async () => {
      setup({ list: THREE });
      await ready();
      const cells = radios();
      cells[1]!.focus();
      fireEvent.keyDown(cells[1]!, { key: "ArrowDown" });
      expect(cells[2]).toHaveFocus();
      fireEvent.keyDown(cells[2]!, { key: "ArrowUp" });
      fireEvent.keyDown(cells[1]!, { key: "ArrowUp" });
      expect(cells[0]).toHaveFocus();
      fireEvent.keyDown(cells[0]!, { key: "ArrowUp" });
      expect(cells[0]).toHaveFocus();
    });

    it("焦點離開群組後，Tab 停點回到選中的那格；群組內移動不重設", async () => {
      setup({ list: THREE });
      await ready();
      const cells = radios();
      cells[1]!.focus();
      fireEvent.keyDown(cells[1]!, { key: "ArrowRight" });
      expect(radios().map(c => c.tabIndex)).toEqual([-1, -1, 0, -1]);
      act(() => screen.getByRole("button", { name: "Upload a picture" }).focus());
      expect(radios().map(c => c.tabIndex)).toEqual([-1, 0, -1, -1]);
    });

    it("Home／End 跳到第一格與最後一格", async () => {
      setup({ list: THREE });
      await ready();
      const cells = radios();
      cells[1]!.focus();
      fireEvent.keyDown(cells[1]!, { key: "End" });
      expect(cells[3]).toHaveFocus();
      expect(radios().map(c => c.tabIndex)).toEqual([-1, -1, -1, 0]);
      fireEvent.keyDown(cells[3]!, { key: "Home" });
      expect(cells[0]).toHaveFocus();
      expect(radios().map(c => c.tabIndex)).toEqual([0, -1, -1, -1]);
    });
  });

  describe("選用", () => {
    it("點一張候選送 PUT /api/auth/avatar { candidateId }，成功出 toast", async () => {
      const { calls } = setup({ list: THREE });
      await ready();
      fireEvent.click(radios()[2]!);
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      expect(mutations(calls)[0]).toMatchObject({ method: "PUT", url: "/api/auth/avatar" });
      expect(JSON.parse(String(mutations(calls)[0]!.body))).toEqual({ candidateId: ID_B });
      expect(await screen.findByText("Profile picture updated")).toBeInTheDocument();
    });

    it("選「不使用頭貼」送 { candidateId: null }", async () => {
      const { calls } = setup({ list: THREE });
      await ready();
      fireEvent.click(radios()[0]!);
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      expect(JSON.parse(String(mutations(calls)[0]!.body))).toEqual({ candidateId: null });
    });

    it("再點已選中的那格不送請求", async () => {
      const { calls } = setup({ list: THREE });
      await ready();
      fireEvent.click(radios()[1]!);
      await settle();
      expect(mutations(calls)).toHaveLength(0);
    });

    it("失敗：server_busy 出忙碌訊息；其他錯誤出一般錯誤；都不出成功 toast", async () => {
      const { calls } = setup({
        list: THREE,
        respond: c => (c.method === "PUT" ? json(409, { error: { code: "server_busy", message: "busy" } }) : undefined),
      });
      await ready();
      fireEvent.click(radios()[2]!);
      expect(await screen.findByText("The server is busy. Please try again shortly.")).toBeInTheDocument();
      expect(screen.queryByText("Profile picture updated")).not.toBeInTheDocument();
      expect(mutations(calls)).toHaveLength(1);
    });

    it("失敗：非忙碌的錯誤出一般錯誤訊息", async () => {
      setup({ list: THREE, respond: c => (c.method === "PUT" ? json(500, { error: { code: "internal", message: "x" } }) : undefined) });
      await ready();
      fireEvent.click(radios()[2]!);
      expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    });

    it("404（候選剛被別的分頁刪掉）→ 重抓清單、不出錯誤 toast", async () => {
      const { calls } = setup({
        list: THREE,
        respond: c => (c.method === "PUT" ? json(404, { error: { code: "not_found", message: "gone" } }) : undefined),
      });
      await ready();
      const before = listCalls(calls).length;
      fireEvent.click(radios()[2]!);
      await waitFor(() => expect(listCalls(calls).length).toBe(before + 1));
      expect(screen.queryByText("Something went wrong. Please try again.")).not.toBeInTheDocument();
    });
  });

  describe("⋮ 與結構", () => {
    it("⋮ 不在任何 radio 裡；Tab 序是 radiogroup 的一個停靠點，之後各候選的 ⋮", async () => {
      setup({ list: THREE });
      await ready();
      const group = screen.getByRole("radiogroup", { name: "Picture options" });
      const menus = screen.getAllByRole("button", { name: /^More actions for / });
      expect(menus).toHaveLength(3);
      for (const menu of menus) expect(group.contains(menu)).toBe(false);
      for (const radio of radios()) expect(radio.querySelector("button")).toBeNull();
      const focusables = [...document.querySelectorAll<HTMLElement>("button, [tabindex]")].filter(el => el.tabIndex >= 0 && el.closest("[data-radix-popper-content-wrapper]") === null);
      const order = focusables.filter(el => el.getAttribute("role") === "radio" || el.getAttribute("aria-label")?.startsWith("More actions for "));
      expect(order.map(el => el.getAttribute("role") ?? "menu")).toEqual(["radio", "menu", "menu", "menu"]);
    });

    it("radiogroup 與 ⋮ 群組共用同一個 grid 模板，且都不是 display: contents", async () => {
      setup({ list: THREE });
      await ready();
      const group = screen.getByRole("radiogroup", { name: "Picture options" });
      const menuGrid = screen.getAllByRole("button", { name: /^More actions for / })[0]!.parentElement!;
      const template = (el: HTMLElement) => el.className.split(/\s+/).filter(c => c.startsWith("grid-cols-"));
      expect(template(group)).toHaveLength(1);
      expect(template(group)).toEqual(template(menuGrid));
      for (const el of [group, menuGrid]) {
        expect(el.className).toContain("col-start-1");
        expect(el.className).toContain("row-start-1");
        expect(el.className).not.toContain("contents");
      }
    });

    it("⋮ 的浮出 class 與祖先的 group/avatarcell 都在（hover 時整區的 ⋮ 才會浮出）", async () => {
      setup({ list: THREE });
      await ready();
      const group = screen.getByRole("radiogroup", { name: "Picture options" });
      expect(group.parentElement!.className.split(/\s+/)).toContain("group/avatarcell");
      const menu = screen.getAllByRole("button", { name: /^More actions for / })[0]!;
      expect(menu.className).toContain("group-hover/avatarcell:opacity-100");
      expect(menu.className).toContain("group-has-[:focus-visible]/avatarcell:opacity-100");
    });

    it("⋮ 視覺 24px，觸控裝置的點擊區擴到 40×44", async () => {
      setup({ list: THREE });
      await ready();
      const classes = screen.getAllByRole("button", { name: /^More actions for / })[0]!.className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["h-6", "w-6", "relative"]));
      expect(classes).toEqual(
        expect.arrayContaining(["pointer-coarse:before:absolute", "pointer-coarse:before:-inset-x-2", "pointer-coarse:before:-inset-y-2.5"]),
      );
    });

    it("⋮ 的選單有「調整裁切」「刪除」兩項", async () => {
      setup({ list: THREE });
      await ready();
      const menu = await openMenu(`More actions for Picture uploaded ${dateLabel("2026-02-05T12:00:00.000Z")}`);
      expect(within(menu).getByRole("menuitem", { name: "Adjust crop" })).toBeInTheDocument();
      expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    });
  });

  describe("調整裁切", () => {
    it("⋮ →「調整裁切」以該候選為來源開裁切框；框關閉後卸載", async () => {
      setup({ list: THREE });
      await ready();
      const menu = await openMenu(`More actions for Picture uploaded ${dateLabel("2026-02-05T12:00:00.000Z")}`);
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Adjust crop" }));
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      expect(dialog).toHaveAttribute("data-kind", "existing");
      expect(dialog).toHaveAttribute("data-name", ID_B);
      fireEvent.click(within(dialog).getByRole("button", { name: "close-stub" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Adjust picture" })).not.toBeInTheDocument());
    });
  });

  describe("上傳與前驗", () => {
    const pick = (file: File) => {
      const input = screen.getByTestId("avatar-file-input") as HTMLInputElement;
      fireEvent.change(input, { target: { files: [file] } });
    };
    const fileOf = (bytes: number, name = "alice.png") => new File([new Uint8Array(bytes)], name, { type: "image/png" });

    it("選檔後清掉 input 的值（同一個檔取消後再選一次才會再觸發 change）", async () => {
      setup();
      await ready();
      const input = screen.getByTestId("avatar-file-input") as HTMLInputElement;
      const writes: string[] = [];
      Object.defineProperty(input, "value", {
        configurable: true,
        get: () => "",
        set: (v: string) => {
          writes.push(v);
        },
      });
      fireEvent.change(input, { target: { files: [fileOf(10)] } });
      expect(writes).toEqual([""]);
    });

    it("按鈕只接受 PNG／JPEG／WebP", async () => {
      setup();
      await ready();
      expect(screen.getByTestId("avatar-file-input")).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
    });

    it("maxUploadBytes=1000、選 1001 bytes → 區塊內顯示超過上限、沒開框、沒送請求", async () => {
      const { calls } = setup({ maxUploadBytes: 1000 });
      await ready();
      await waitFor(() => expect(calls.some(c => c.url === "/api/auth/config")).toBe(true));
      await settle();
      pick(fileOf(1001));
      expect(await screen.findByRole("alert")).toHaveTextContent(`The image is larger than the ${formatBytes(1000)} limit.`);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mutations(calls)).toHaveLength(0);
    });

    it("剛好等於上限 → 開裁切框，並清掉先前的超限訊息", async () => {
      setup({ maxUploadBytes: 1000 });
      await ready();
      await settle();
      pick(fileOf(1001));
      await screen.findByRole("alert");
      pick(fileOf(1000, "bob.png"));
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      expect(dialog).toHaveAttribute("data-kind", "new");
      expect(dialog).toHaveAttribute("data-name", "bob.png");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("maxUploadBytes 沒有值 → 不前驗，直接開框", async () => {
      setup({ maxUploadBytes: undefined });
      await ready();
      await settle();
      pick(fileOf(50_000_000));
      expect(await screen.findByRole("dialog", { name: "Adjust picture" })).toHaveAttribute("data-kind", "new");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("刪除", () => {
    async function openDelete(iso: string) {
      const menu = await openMenu(`More actions for Picture uploaded ${dateLabel(iso)}`);
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
      return screen.findByRole("dialog", { name: "Delete this picture?" });
    }

    it("「刪除」開確認框（含釋放空間），確認前不送請求", async () => {
      const { calls } = setup({ list: THREE });
      await ready();
      const dialog = await openDelete("2026-02-05T12:00:00.000Z");
      expect(dialog).toHaveTextContent(`This can't be undone. It frees ${formatBytes(4000)}.`);
      await settle();
      expect(mutations(calls)).toHaveLength(0);
    });

    it("確認框指出刪的是哪一張", async () => {
      setup({ list: THREE });
      await ready();
      const dialog = await openDelete("2026-02-05T12:00:00.000Z");
      expect(within(dialog).getByText(`Picture uploaded ${dateLabel("2026-02-05T12:00:00.000Z")}`)).toBeInTheDocument();
    });

    describe("刪除後的焦點", () => {
      function stateful() {
        let candidates = THREE.candidates;
        return setup({
          list: THREE,
          respond: c => {
            if (c.method === "DELETE") {
              const id = c.url.split("/").pop();
              candidates = candidates.filter(x => x.id !== id);
              return json(204);
            }
            if (c.method === "GET" && c.url === "/api/auth/avatars") return json(200, { ...THREE, candidates });
            return undefined;
          },
        });
      }
      async function remove(iso: string) {
        const dialog = await openDelete(iso);
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete this picture?" })).not.toBeInTheDocument());
      }

      it("刪中間那張 → 焦點給原位置的下一格", async () => {
        stateful();
        await ready();
        await remove("2026-02-05T12:00:00.000Z");
        await waitFor(() => expect(radios()).toHaveLength(3));
        await waitFor(() => expect(radios()[2]).toHaveFocus());
        expect(radios().map(c => c.tabIndex)).toEqual([-1, -1, 0]);
      });

      it("刪最後一張 → 焦點給上一格", async () => {
        stateful();
        await ready();
        await remove("2026-01-05T12:00:00.000Z");
        await waitFor(() => expect(radios()).toHaveLength(3));
        await waitFor(() => expect(radios()[2]).toHaveFocus());
      });

      it("刪光所有候選 → 焦點給上傳鈕", async () => {
        let candidates = [candidate(ID_A, { current: true })];
        setup({
          respond: c => {
            if (c.method === "DELETE") {
              candidates = [];
              return json(204);
            }
            if (c.method === "GET" && c.url === "/api/auth/avatars") return json(200, { candidates, auto: false, refreshable: [] });
            return undefined;
          },
        });
        await ready();
        await remove("2026-03-05T12:00:00.000Z");
        await waitFor(() => expect(radios()).toHaveLength(1));
        await waitFor(() => expect(screen.getByRole("button", { name: "Upload a picture" })).toHaveFocus());
      });
    });

    it("取消不送請求、框關閉", async () => {
      const { calls } = setup({ list: THREE });
      await ready();
      const dialog = await openDelete("2026-02-05T12:00:00.000Z");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(mutations(calls)).toHaveLength(0);
    });

    it("確認後送 DELETE；刪的是目前那張 → 出「改用首字」toast", async () => {
      const { calls } = setup({ list: THREE });
      await ready();
      const dialog = await openDelete("2026-03-05T12:00:00.000Z");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      expect(mutations(calls)[0]).toMatchObject({ method: "DELETE", url: `/api/auth/avatars/${ID_A}` });
      expect(await screen.findByText("Deleted. Your initial is shown instead.")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete this picture?" })).not.toBeInTheDocument());
    });

    it("刪的不是目前那張 → 一般的「已刪除」toast", async () => {
      setup({ list: THREE });
      await ready();
      const dialog = await openDelete("2026-02-05T12:00:00.000Z");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      expect(await screen.findByText("Picture deleted.")).toBeInTheDocument();
      expect(screen.queryByText("Deleted. Your initial is shown instead.")).not.toBeInTheDocument();
    });

    it("404 → 重抓清單、框關閉", async () => {
      const { calls } = setup({
        list: THREE,
        respond: c => (c.method === "DELETE" ? json(404, { error: { code: "not_found", message: "gone" } }) : undefined),
      });
      await ready();
      const before = listCalls(calls).length;
      const dialog = await openDelete("2026-02-05T12:00:00.000Z");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(listCalls(calls).length).toBe(before + 1));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete this picture?" })).not.toBeInTheDocument());
    });

    it("server_busy → 忙碌訊息、框關閉；沒有成功 toast", async () => {
      setup({
        list: THREE,
        respond: c => (c.method === "DELETE" ? json(409, { error: { code: "server_busy", message: "busy" } }) : undefined),
      });
      await ready();
      const dialog = await openDelete("2026-02-05T12:00:00.000Z");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      expect(await screen.findByText("The server is busy. Please try again shortly.")).toBeInTheDocument();
      expect(screen.queryByText("Picture deleted.")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete this picture?" })).not.toBeInTheDocument());
    });
  });

  it("目前頭貼預覽：user.avatar 有值時顯示該圖（64 px）", async () => {
    // 預覽走 Avatar：有 avatar 就渲染 <img src=avatarUrl>。
    vi.stubGlobal("fetch", vi.fn());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["me"], { ...USER, avatar: { id: ID_A, v: 7, pending: false } });
    queryClient.setQueryData(["avatars"], { candidates: [], auto: false, refreshable: [] });
    queryClient.setQueryData(["auth-config"], { providers: [] });
    render(
      <QueryClientProvider client={queryClient}>
        <AvatarSection />
      </QueryClientProvider>,
    );
    const img = document.querySelector("section img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`/api/avatars/${ID_A}?v=7`);
    expect((img.parentElement as HTMLElement).style.width).toBe("64px");
  });
});
