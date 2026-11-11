import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TrashSettingsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { TRASH_SETTINGS_QUERY_KEY } from "@/api/trash";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SiteTrashGroup } from "./SettingsTrashSection";

// 站台垃圾桶設定（#181）。單獨渲染 `SiteTrashGroup`，查詢一律經垃圾桶 region 圈定；整頁排列在 SettingsStorageSection.test.tsx。

const URL_ = "/api/admin/trash/settings";
const EN_DESCRIPTION =
  "Notes moved to the trash are permanently deleted once they've been there longer than this (checked once an hour). If you shorten it, notes already past the new limit are deleted starting at the next check (up to 2,000 per check).";
const ZH_DESCRIPTION =
  "筆記移到垃圾桶後，超過保留天數會自動永久刪除（每小時檢查一次）。縮短天數時，已超過新天數的筆記會從下一次檢查開始刪除（每次最多 2,000 篇）。";
const INVALID = "Use a whole number from 1 to 3650.";

function res(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

interface Server {
  settings: TrashSettingsDto;
  get?: () => Promise<Response>;
  patch?: (body: unknown) => Response | Promise<Response>;
}

function setup(server: Server) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === URL_ && method === "GET") return server.get ? server.get() : Promise.resolve(res(200, server.settings));
    if (url === URL_ && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as TrashSettingsDto;
      return Promise.resolve(server.patch ? server.patch(body) : res(200, body));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SiteTrashGroup />
      <Toaster />
    </QueryClientProvider>,
  );
  const patches = () =>
    fetchMock.mock.calls
      .filter(([u, i]) => String(u) === URL_ && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "PATCH")
      .map(([, i]) => String((i as RequestInit).body));
  return { fetchMock, queryClient, patches };
}

const area = () => within(screen.getByRole("region", { name: i18n.t("admin.trash.title") }));
const daysField = () => area().getByLabelText("Days to keep");
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("SiteTrashGroup（站台垃圾桶設定，#181）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ST-1 GET 7 → 標題 Trash、開關勾、天數 7、說明句（精確版，含每次最多 2,000 篇）", async () => {
    setup({ settings: { retentionDays: 7 } });
    expect(await screen.findByRole("switch", { name: "Delete automatically" })).toHaveAttribute("aria-checked", "true");
    expect(area().getByRole("heading", { level: 2, name: "Trash" })).toBeInTheDocument();
    expect(area().getByRole("switch", { name: "Delete automatically" })).toHaveAttribute("aria-checked", "true");
    expect(daysField()).toHaveValue("7");
    expect(area().getByText(EN_DESCRIPTION)).toBeInTheDocument();
  });

  it("ST-2 改 30 → Save → PATCH {retentionDays:30}、toast", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "30" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Trash settings saved", { exact: true })).toBeInTheDocument();
    expect(patches()).toEqual(['{"retentionDays":30}']);
    expect(area().queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ST-2b PATCH 懸著時 Save disabled（不重送）；回應後恢復", async () => {
    let release: (r: Response) => void = () => {};
    const { patches } = setup({
      settings: { retentionDays: 7 },
      patch: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "30" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":30}']));
    expect(area().getByRole("button", { name: "Save" })).toBeDisabled();
    release(res(200, { retentionDays: 30 }));
    await waitFor(() => expect(area().getByRole("button", { name: "Save" })).not.toBeDisabled());
  });

  it("ST-3 0／3651／abc／1.5／空 → 行內錯誤、不送；改字就清掉錯誤", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    for (const value of ["0", "3651", "abc", "1.5", ""]) {
      fireEvent.change(daysField(), { target: { value } });
      // 改欄位會清掉上一組的錯誤——下面的 alert 是這一組送出才出現的
      expect(area().queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(area().getByRole("button", { name: "Save" }));
      expect(await area().findByRole("alert")).toHaveTextContent(INVALID);
    }
    await tick();
    expect(patches()).toEqual([]);
  });

  it("ST-3c 出現行內錯誤後切開關 → 錯誤消失", async () => {
    setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "0" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    expect(await area().findByRole("alert")).toHaveTextContent(INVALID);
    fireEvent.click(area().getByRole("switch", { name: "Delete automatically" }));
    expect(area().queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ST-3b 邊界 1 與 3650 → 都送出 PATCH", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "1" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":1}']));
    await waitFor(() => expect(area().getByRole("button", { name: "Save" })).not.toBeDisabled());
    fireEvent.change(daysField(), { target: { value: "3650" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":1}', '{"retentionDays":3650}']));
    expect(area().queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ST-8 儲存成功後清掉本地值：server 之後改成 40、重抓 → 欄位顯示 40", async () => {
    const server: Server = { settings: { retentionDays: 7 } };
    const { queryClient } = setup(server);
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "30" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await screen.findByText("Trash settings saved", { exact: true });
    server.settings = { retentionDays: 40 };
    await queryClient.invalidateQueries({ queryKey: TRASH_SETTINGS_QUERY_KEY });
    await waitFor(() => expect(daysField()).toHaveValue("40"));
  });

  it("ST-8b 儲存成功後也清掉本地開關：server 原為 null → 打開存 30 → server 改回 null、重抓 → 開關未勾", async () => {
    const server: Server = { settings: { retentionDays: null } };
    const { queryClient } = setup(server);
    fireEvent.click(await screen.findByRole("switch", { name: "Delete automatically" }));
    fireEvent.change(daysField(), { target: { value: "30" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await screen.findByText("Trash settings saved", { exact: true });
    server.settings = { retentionDays: null };
    await queryClient.invalidateQueries({ queryKey: TRASH_SETTINGS_QUERY_KEY });
    await waitFor(() => expect(area().getByRole("switch", { name: "Delete automatically" })).toHaveAttribute("aria-checked", "false"));
    expect(area().queryByLabelText("Days to keep")).not.toBeInTheDocument();
  });

  it("ST-4 關開關 → 天數欄消失 → Save → PATCH {retentionDays:null}", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    fireEvent.click(await screen.findByRole("switch", { name: "Delete automatically" }));
    expect(area().getByRole("switch", { name: "Delete automatically" })).toHaveAttribute("aria-checked", "false");
    expect(area().queryByLabelText("Days to keep")).not.toBeInTheDocument();
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":null}']));
    expect(await screen.findByText("Trash settings saved", { exact: true })).toBeInTheDocument();
  });

  it("ST-4b 天數填了不合法的值再關開關 → Save 照樣送 {retentionDays:null}、沒有行內錯誤（關閉時不驗天數）", async () => {
    const { patches } = setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "abc" } });
    fireEvent.click(area().getByRole("switch", { name: "Delete automatically" }));
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":null}']));
    await screen.findByText("Trash settings saved", { exact: true });
    expect(area().queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ST-5 server null → 開關未勾、沒有天數欄；打開 → 天數欄預設 7；沒按 Save 就沒有 PATCH", async () => {
    const { patches } = setup({ settings: { retentionDays: null } });
    const sw = await screen.findByRole("switch", { name: "Delete automatically" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(area().queryByLabelText("Days to keep")).not.toBeInTheDocument();
    fireEvent.click(sw);
    expect(daysField()).toHaveValue("7");
    await tick();
    expect(patches()).toEqual([]);
  });

  it("ST-6a PATCH 400 → 行內 errors.invalid_body", async () => {
    setup({ settings: { retentionDays: 7 }, patch: () => res(400, { error: { code: "invalid_body", message: "x" } }) });
    await screen.findByRole("switch", { name: "Delete automatically" });
    fireEvent.change(daysField(), { target: { value: "9" } });
    fireEvent.click(area().getByRole("button", { name: "Save" }));
    expect(await area().findByRole("alert")).toHaveTextContent(i18n.t("errors.invalid_body"));
  });

  it("ST-6b GET 500 → 同標題 region 內 role=alert", async () => {
    setup({ settings: { retentionDays: 7 }, get: () => Promise.resolve(res(500, { error: { code: "boom", message: "x" } })) });
    expect(await area().findByRole("alert")).toHaveTextContent(i18n.t("errors.fallback"));
    expect(area().queryByRole("switch")).not.toBeInTheDocument();
  });

  it("ST-6c GET 懸著 → 同標題 region 內 Loading…", async () => {
    setup({ settings: { retentionDays: 7 }, get: () => new Promise<Response>(() => {}) });
    expect(area().getByText("Loading…")).toBeInTheDocument();
    expect(area().queryByRole("switch")).not.toBeInTheDocument();
  });

  it("ST-7 zh-TW 說明句逐字＝精確版（從下一次檢查開始刪除、每次最多 2,000 篇）", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ settings: { retentionDays: 7 } });
    await screen.findByRole("switch", { name: "自動永久刪除" });
    expect(area().getByText(ZH_DESCRIPTION)).toBeInTheDocument();
  });
});
