import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SITE_LIMIT_KEYS, type SiteLimitChangeDto, type SiteLimitsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SITE_LIMITS_QUERY_KEY } from "@/api/siteLimits";
import { siteLimitsDto } from "@/test/site-limits-fixtures";
import { categoryKeys, PAGE_CATEGORIES, SettingsLimitsSection } from "./SettingsLimitsSection";

const URL_ = "/api/admin/limits";
const GiB = 1024 ** 3;

function res(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const dto = siteLimitsDto;

interface Server {
  data: SiteLimitsDto;
  patch?: (body: unknown) => Response | Promise<Response>;
  /** 設成真值後，之後的 GET 回 500。 */
  failGet?: boolean;
}

function setup(server: Server) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === URL_ && method === "GET") return Promise.resolve(server.failGet ? res(500, { error: { code: "internal", message: "x" } }) : res(200, server.data));
    if (url === URL_ && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as unknown;
      return Promise.resolve(server.patch ? server.patch(body) : res(200, server.data));
    }
    if (url === "/api/auth/config" && method === "GET") return Promise.resolve(res(200, {}));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsLimitsSection />
      <Toaster />
    </QueryClientProvider>,
  );
  const patches = () =>
    fetchMock.mock.calls
      .filter(([u, i]) => String(u) === URL_ && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "PATCH")
      .map(([, i]) => JSON.parse(String((i as RequestInit).body)) as unknown);
  return { fetchMock, patches, queryClient };
}

const block = (name: string) => within(screen.getByRole("region", { name }));
const row = (name: string) => within(screen.getByRole("group", { name }));
const field = (name: string) => screen.getByLabelText(name, { selector: "input" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const loaded = () => screen.findByRole("heading", { level: 1, name: "Site limits" }).then(() => screen.findByLabelText("Note size limit", { selector: "input" }));

describe("SettingsLimitsSection（站台限制分頁）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("依分類分三組（批次讀寫沒項目不畫、登入兩項不在這頁），最後是最近的修改", async () => {
    setup({ data: dto() });
    await loaded();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Uploads and notes",
      "Parse workers",
      "Rate limits",
      "Recent changes",
    ]);
    expect(screen.queryByText("Bulk transfer")).not.toBeInTheDocument();
    expect(screen.queryByText("Web sign-in lasts")).not.toBeInTheDocument();
    expect(screen.queryByText("Active API tokens per person")).not.toBeInTheDocument();
    expect(block("Uploads and notes").getAllByRole("group").map((g) => g.getAttribute("data-limit-key"))).toEqual(["uploadMaxBytes", "noteMaxBytes"]);
    expect(block("Parse workers").getAllByRole("group").map((g) => g.getAttribute("data-limit-key"))).toEqual([
      "parseWorkers",
      "parseWorkerMemoryMb",
      "parseTimeoutMs",
      "parseQueueWaitMs",
    ]);
    expect(block("Rate limits").getAllByRole("group")).toHaveLength(9);
  });

  it("每列有「預設 X · 範圍 A–B」，速率限制列多視窗（per minute／per 10 minutes／per hour）", async () => {
    setup({ data: dto() });
    await loaded();
    expect(row("Note size limit").getByText("Default 5 MiB · Range 1–5 MiB")).toBeInTheDocument();
    expect(row("Parse time limit").getByText("Default 10 seconds · Range 4–10 seconds")).toBeInTheDocument();
    expect(row("Parse workers").getByText("Default auto · Range 1–4 workers")).toBeInTheDocument();
    expect(row("API and MCP reads").getByText("Default 300 times · Range 30–300 times · per minute")).toBeInTheDocument();
    expect(row("API and MCP writes").getByText("Default 60 times · Range 6–60 times · per 10 minutes")).toBeInTheDocument();
    expect(row("Bulk downloads").getByText("Default 10 times · Range 1–10 times · per hour")).toBeInTheDocument();
  });

  it("中文：「預設 X · 範圍 A–B」與「每 N 分鐘」", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ data: dto() });
    await screen.findByLabelText("筆記大小上限", { selector: "input" });
    expect(within(screen.getByRole("group", { name: "筆記大小上限" })).getByText("預設 5 MiB · 範圍 1–5 MiB")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "API／MCP 寫入次數" })).getByText("預設 60 次 · 範圍 6–60 次 · 每 10 分鐘")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "解析 worker 數" })).getByText("預設 自動 · 範圍 1–4 個")).toBeInTheDocument();
  });

  it("env 項：輸入框 disabled、.env 說明；在範圍內但沒對齊的值照 bytes 原樣顯示、不標超出範圍", async () => {
    setup({ data: dto({ noteMaxBytes: { value: 3_145_729, source: "env", locked: true } }) });
    await loaded();
    expect(field("Note size limit")).toBeDisabled();
    expect(field("Note size limit")).toHaveValue("3 145 729 bytes");
    expect(row("Note size limit").getByText("Set by NOTE_MAX_BYTES in .env. To change it, edit .env and restart the server.")).toBeInTheDocument();
    expect(row("Note size limit").queryByText("Outside the range this page can set.")).not.toBeInTheDocument();
    expect(row("Note size limit").queryByText(/is not applied/)).not.toBeInTheDocument();
    expect(row("Note size limit").queryByText("MiB")).not.toBeInTheDocument(); // 原文已帶單位，框旁不再標 MiB
    expect(field("Note size limit")).toHaveAccessibleDescription(/Set by NOTE_MAX_BYTES in \.env/);
  });

  it("env 值 5242881 超出範圍也沒對齊 → bytes 原值（分位）＋「超出管理頁可調範圍」", async () => {
    setup({ data: dto({ noteMaxBytes: { value: 5_242_881, source: "env", locked: true } }) });
    await loaded();
    expect(field("Note size limit")).toHaveValue("5 242 881 bytes");
    expect(row("Note size limit").getByText("Outside the range this page can set.")).toBeInTheDocument();
    expect(field("Note size limit")).toHaveAccessibleDescription(/Outside the range this page can set\./);
  });

  it("中文：沒對齊的 env 值一樣以空格分位、照 API 單位顯示", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ data: dto({ noteMaxBytes: { value: 5_242_881, source: "env", locked: true }, parseTimeoutMs: { value: 12_345, source: "env", locked: true } }) });
    await screen.findByLabelText("筆記大小上限", { selector: "input" });
    expect(screen.getByLabelText("筆記大小上限", { selector: "input" })).toHaveValue("5 242 881 bytes");
    expect(screen.getByLabelText("解析時限", { selector: "input" })).toHaveValue("12 345 ms");
    expect(within(screen.getByRole("group", { name: "筆記大小上限" })).getByText("超出管理頁可調範圍。")).toBeInTheDocument();
  });

  it("env 值 104857600 對齊但超出範圍 → 以輸入單位顯示 100 MiB＋「超出管理頁可調範圍」", async () => {
    setup({ data: dto({ noteMaxBytes: { value: 104_857_600, source: "env", locked: true } }) });
    await loaded();
    expect(field("Note size limit")).toHaveValue("100");
    expect(row("Note size limit").getByText("MiB")).toBeInTheDocument();
    expect(row("Note size limit").getByText("Outside the range this page can set.")).toBeInTheDocument();
  });

  it("env 的 worker 數 8（env 可給、超出管理頁範圍）→ 顯示 8、單位是 workers、標超出範圍", async () => {
    setup({ data: dto({ parseWorkers: { value: 8, source: "env", locked: true } }) });
    await loaded();
    expect(field("Parse workers")).toHaveValue("8");
    expect(row("Parse workers").getByText("workers")).toBeInTheDocument();
    expect(row("Parse workers").queryByText("times")).not.toBeInTheDocument();
    expect(row("Parse workers").getByText("Outside the range this page can set.")).toBeInTheDocument();
  });

  it("單位分單複數：值是 1 時框旁是單數", async () => {
    setup({ data: dto({ parseWorkers: { value: 1, source: "admin", stored: 1 }, rateTransferExport: { value: 1, source: "admin", stored: 1 } }) });
    await loaded();
    expect(row("Parse workers").getByText("worker")).toBeInTheDocument();
    expect(row("Bulk downloads").getByText("time")).toBeInTheDocument();
    fireEvent.change(field("Parse workers"), { target: { value: "3" } });
    expect(row("Parse workers").getByText("workers")).toBeInTheDocument();
  });

  it("env 鎖住但管理頁也存了值 → 「管理頁存的值 X 不會生效」", async () => {
    setup({ data: dto({ parseTimeoutMs: { value: 12_345, source: "env", locked: true, stored: 8_000 } }) });
    await loaded();
    expect(field("Parse time limit")).toHaveValue("12 345 ms");
    expect(row("Parse time limit").getByText("Set by PARSE_TIMEOUT_MS in .env. To change it, edit .env and restart the server.")).toBeInTheDocument();
    expect(row("Parse time limit").getByText("The value saved on this page (8 seconds) is not applied.")).toBeInTheDocument();
  });

  it("env 給的值對齊時以輸入單位顯示", async () => {
    setup({ data: dto({ parseWorkerMemoryMb: { value: 2_048, source: "env", locked: true } }) });
    await loaded();
    expect(field("Memory per worker")).toHaveValue("2048");
    expect(field("Memory per worker")).toBeDisabled();
    expect(row("Memory per worker").queryByRole("button")).not.toBeInTheDocument();
  });

  it("自動項：輸入框空白、placeholder 是自動值、標「自動：N（依 CPU）」", async () => {
    setup({ data: dto() });
    await loaded();
    expect(field("Parse workers")).toHaveValue("");
    expect(field("Parse workers")).toHaveAttribute("placeholder", "4");
    expect(row("Parse workers").getByText("Auto: 4 (based on CPUs)")).toBeInTheDocument();
    expect(field("Longest wait for a worker")).toHaveValue("");
    expect(field("Longest wait for a worker")).toHaveAttribute("placeholder", "45");
    expect(row("Longest wait for a worker").getByText("Auto: 45 seconds")).toBeInTheDocument();
    expect(field("Parse workers")).toHaveAccessibleDescription(/Auto: 4 \(based on CPUs\)/);
  });

  it("自動值沒對齊輸入刻度 → 不放 placeholder，原值寫在「自動：…」", async () => {
    setup({ data: dto({ parseQueueWaitMs: { value: 54_380, autoValue: 54_380 } }) });
    await loaded();
    expect(field("Longest wait for a worker")).not.toHaveAttribute("placeholder");
    expect(row("Longest wait for a worker").getByText("Auto: 54 380 ms")).toBeInTheDocument();
  });

  it("自動項依記憶體 → 「依記憶體」", async () => {
    setup({ data: dto({ parseWorkers: { value: 2, autoValue: 2, autoSource: "memory" } }) });
    await loaded();
    expect(row("Parse workers").getByText("Auto: 2 (based on memory)")).toBeInTheDocument();
  });

  it("storedIgnored → 「存的值 X 超出目前範圍，未套用」", async () => {
    setup({ data: dto({ uploadMaxBytes: { stored: 20 * 1_048_576, storedIgnored: true } }) });
    await loaded();
    expect(row("Upload size limit").getByText("The saved value 20 MiB is outside the current range and is not applied.")).toBeInTheDocument();
    expect(field("Upload size limit")).toHaveValue("10");
  });

  it("輸入 0.5、1.5、空白（非自動項）→ 行內錯誤、不發 PATCH", async () => {
    const { patches } = setup({ data: dto() });
    await loaded();
    for (const [label, value, blockName] of [
      ["Note size limit", "0.5", "Uploads and notes"],
      ["Note size limit", "", "Uploads and notes"],
      ["Parse time limit", "1.5", "Parse workers"],
    ] as const) {
      fireEvent.change(field(label), { target: { value } });
      fireEvent.click(block(blockName).getByRole("button", { name: "Save" }));
      expect(await row(label).findByRole("alert")).toHaveTextContent("Enter a whole number.");
      fireEvent.change(field(label), { target: { value: label === "Note size limit" ? "5" : "10" } });
    }
    await tick();
    expect(patches()).toEqual([]);
  });

  it("超出範圍 → 「請輸入 A 到 B 的整數」（輸入單位）、不發 PATCH", async () => {
    const { patches } = setup({ data: dto() });
    await loaded();
    fireEvent.change(field("Note size limit"), { target: { value: "6" } });
    fireEvent.click(block("Uploads and notes").getByRole("button", { name: "Save" }));
    expect(await row("Note size limit").findByRole("alert")).toHaveTextContent("Enter a whole number from 1 to 5.");
    await tick();
    expect(patches()).toEqual([]);
  });

  it("自動項打了值又清空 → 不送那個 key、沒有錯誤；只送變更過的 key（以 API 單位）", async () => {
    const { patches } = setup({ data: dto() });
    await loaded();
    fireEvent.change(field("Parse workers"), { target: { value: "2" } });
    fireEvent.change(field("Parse workers"), { target: { value: "" } });
    fireEvent.change(field("Parse time limit"), { target: { value: "8" } });
    fireEvent.click(block("Parse workers").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { parseTimeoutMs: 8_000 } }]));
    expect(block("Parse workers").queryByRole("alert")).not.toBeInTheDocument();
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("已調整的自動項清空後儲存 → 送 null（改回自動）、沒有驗證錯誤", async () => {
    const { patches } = setup({ data: dto({ parseWorkers: { value: 2, source: "admin", stored: 2 } }) });
    await loaded();
    expect(field("Parse workers")).toHaveValue("2");
    fireEvent.change(field("Parse workers"), { target: { value: "" } });
    fireEvent.click(block("Parse workers").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { parseWorkers: null } }]));
    expect(block("Parse workers").queryByRole("alert")).not.toBeInTheDocument();
  });

  it("各區塊各自儲存：改了兩個區塊，按其中一個只送該區塊的 key；值沒變的不送", async () => {
    const { patches } = setup({ data: dto() });
    await loaded();
    fireEvent.change(field("Note content writes"), { target: { value: "20" } });
    fireEvent.change(field("AI actions"), { target: { value: "29" } });
    fireEvent.change(field("AI actions"), { target: { value: "30" } }); // 改回與目前值相同
    fireEvent.change(field("Note size limit"), { target: { value: "2" } });
    fireEvent.click(block("Rate limits").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { rateEdit: 20 } }]));
  });

  it("自動項輸入了值 → 送那個值", async () => {
    const { patches } = setup({ data: dto() });
    await loaded();
    fireEvent.change(field("Parse workers"), { target: { value: "2" } });
    fireEvent.click(block("Parse workers").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { parseWorkers: 2 } }]));
  });

  it("已調整：標「已調整」；「恢復預設」送 null；自動項的鈕是「改回自動」", async () => {
    const { patches } = setup({
      data: dto({
        rateSearch: { value: 30, source: "admin", stored: 30 },
        parseWorkers: { value: 2, source: "admin", stored: 2 },
      }),
    });
    await loaded();
    expect(row("Searches").getByText("Adjusted")).toBeInTheDocument();
    expect(field("Searches")).toHaveValue("30");
    expect(row("Parse workers").queryByRole("button", { name: "Restore default" })).not.toBeInTheDocument();
    expect(row("Note size limit").queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(row("Searches").getByRole("button", { name: "Restore default" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { rateSearch: null } }]));
    fireEvent.click(row("Parse workers").getByRole("button", { name: "Back to auto" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { rateSearch: null } }, { set: { parseWorkers: null } }]));
  });

  it("「恢復預設」成功後清掉該列先前的驗證錯誤", async () => {
    const { patches } = setup({ data: dto({ rateSearch: { value: 30, source: "admin", stored: 30 } }) });
    await loaded();
    fireEvent.change(field("Searches"), { target: { value: "abc" } });
    fireEvent.click(block("Rate limits").getByRole("button", { name: "Save" }));
    expect(await row("Searches").findByRole("alert")).toHaveTextContent("Enter a whole number.");
    fireEvent.click(row("Searches").getByRole("button", { name: "Restore default" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { rateSearch: null } }]));
    await waitFor(() => expect(row("Searches").queryByRole("alert")).not.toBeInTheDocument());
  });

  it("伺服器回 409 limit_locked_by_env → 區塊頂顯示該文案", async () => {
    setup({
      data: dto(),
      patch: () => res(409, { error: { code: "limit_locked_by_env", message: "noteMaxBytes is set by the server's environment variable NOTE_MAX_BYTES." } }),
    });
    await loaded();
    fireEvent.change(field("Note size limit"), { target: { value: "2" } });
    fireEvent.click(block("Uploads and notes").getByRole("button", { name: "Save" }));
    const alert = await block("Uploads and notes").findByRole("alert");
    expect(alert).toHaveTextContent("This setting is set in the server's .env file. Change it there and restart the server.");
    expect(within(screen.getByRole("region", { name: "Rate limits" })).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("伺服器回 400 → 「數值不在可調範圍內」，不顯示英文 message", async () => {
    setup({
      data: dto(),
      patch: () => res(400, { error: { code: "invalid_body", message: "noteMaxBytes must be a multiple of 1048576." } }),
    });
    await loaded();
    fireEvent.change(field("Note size limit"), { target: { value: "2" } });
    fireEvent.click(block("Uploads and notes").getByRole("button", { name: "Save" }));
    expect(await block("Uploads and notes").findByRole("alert")).toHaveTextContent("A value is outside the range that can be set.");
    expect(screen.queryByText(/multiple of/)).not.toBeInTheDocument();
  });

  describe("記憶體警告", () => {
    const WARNING = /^May exceed memory/;
    const twoGiB = (cpus: number) =>
      dto(
        { parseWorkers: { value: 1, autoValue: 1, autoSource: "memory" } },
        { machine: { cpus, cpuSource: "os", memoryBytes: 2 * GiB, memorySource: "os" } },
      );

    it("worker 數自動、記憶體上限改成 512 → 用重算的 N＝2 → 2788.8 MB > 2048 → 出現；仍可儲存", async () => {
      const { patches } = setup({ data: twoGiB(8) });
      await loaded();
      fireEvent.change(field("Memory per worker"), { target: { value: "512" } });
      const warning = block("Parse workers").getByText(WARNING);
      expect(warning).toHaveTextContent("about 2789 MB needed (2 workers × (512 + 150) MB + 1000 MB, plus 20%)");
      const save = block("Parse workers").getByRole("button", { name: "Save" });
      expect(save).not.toBeDisabled();
      fireEvent.click(save);
      await waitFor(() => expect(patches()).toEqual([{ set: { parseWorkerMemoryMb: 512 } }]));
    });

    it("同上但 2 個 CPU → N＝1 → 1994.4 MB ≤ 2048 → 不出現；仍可儲存", async () => {
      const { patches } = setup({ data: twoGiB(2) });
      await loaded();
      // 改之前：1 × (1024 + 150) + 1000 再加 20% ＝ 2608.8 MB > 2048，單數 worker
      expect(block("Parse workers").getByText(WARNING)).toHaveTextContent("about 2609 MB needed (1 worker × (1024 + 150) MB + 1000 MB, plus 20%)");
      fireEvent.change(field("Memory per worker"), { target: { value: "512" } });
      expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
      const save = block("Parse workers").getByRole("button", { name: "Save" });
      expect(save).not.toBeDisabled();
      fireEvent.click(save);
      await waitFor(() => expect(patches()).toEqual([{ set: { parseWorkerMemoryMb: 512 } }]));
    });
  });

  it("解析時限、記憶體、排隊等待三列有調低後果的說明", async () => {
    setup({ data: dto() });
    await loaded();
    expect(row("Parse time limit").getByText(/^Lowering this may reject writes of densely formatted content/)).toBeInTheDocument();
    expect(row("Memory per worker").getByText(/^Lowering this may reject densely formatted content \(measured at 640–768 MiB\)/)).toBeInTheDocument();
    expect(row("Longest wait for a worker").getByText(/^If this is shorter than 4 × the parse time limit \+ 5 seconds/)).toBeInTheDocument();
    expect(row("Parse workers").queryByText(/^Lowering this/)).not.toBeInTheDocument();
    expect(row("Note size limit").queryByText(/^Lowering this/)).not.toBeInTheDocument();
  });

  it("解析 worker 區塊頂端：CPU 數、GiB、記憶體來源都從 machine 取（en／zh 逐字）", async () => {
    setup({ data: dto({}, { machine: { cpus: 8, cpuSource: "os", memoryBytes: 16 * GiB, memorySource: "cgroup-v2" } }) });
    await loaded();
    expect(block("Parse workers").getByText("This server: 8 CPUs, 16 GiB memory (cgroup-v2)")).toBeInTheDocument();
    expect(screen.queryByText(/^May exceed memory/)).not.toBeInTheDocument(); // 4 × (1024 + 150) + 1000 再加 20% 遠低於 16 GiB
  });

  it("只有 1 個 CPU → 單數「1 CPU」", async () => {
    setup({ data: dto({}, { machine: { cpus: 1, cpuSource: "os", memoryBytes: 16 * GiB, memorySource: "os" } }) });
    await loaded();
    expect(block("Parse workers").getByText("This server: 1 CPU, 16 GiB memory (os)")).toBeInTheDocument();
  });

  it("說明文字與「調低後…」都掛在輸入框的 aria-describedby；記憶體警告是 status", async () => {
    setup({ data: dto({ parseWorkers: { value: 1, autoValue: 1, autoSource: "memory" } }, { machine: { cpus: 8, cpuSource: "os", memoryBytes: 2 * GiB, memorySource: "os" } }) });
    await loaded();
    expect(field("Memory per worker")).toHaveAccessibleDescription(/Memory each worker may use./);
    expect(field("Memory per worker")).toHaveAccessibleDescription(/Lowering this may reject densely formatted content/);
    fireEvent.change(field("Memory per worker"), { target: { value: "512" } });
    expect(block("Parse workers").getByRole("status")).toHaveTextContent(/^May exceed memory/);
  });

  it("解析 worker 區塊頂端（zh）", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ data: dto({}, { machine: { cpus: 6, cpuSource: "os", memoryBytes: 12 * GiB, memorySource: "cgroup-v1" } }) });
    await screen.findByLabelText("筆記大小上限", { selector: "input" });
    expect(screen.getByText("這台伺服器：6 個 CPU、12 GiB 記憶體（cgroup-v1）")).toBeInTheDocument();
  });

  it("修改紀錄表：已不存在的帳號、預設（X）／自動（X）、輸入單位；不在註冊表的 key 照列", async () => {
    const actor = { id: "u-a", email: "alice@example.com", displayName: "Alice" };
    const changes: SiteLimitChangeDto[] = [
      { id: "c1", key: "noteMaxBytes", oldValue: null, newValue: 2_097_152, oldEffective: 5_242_880, newEffective: 2_097_152, actor, changedAt: "2026-01-02T03:04:05.000Z" },
      { id: "c2", key: "parseWorkers", oldValue: 2, newValue: null, oldEffective: 2, newEffective: 4, actor: null, changedAt: "2026-01-02T03:04:05.000Z" },
      { id: "c3", key: "parseQueueWaitMs", oldValue: null, newValue: 30_000, oldEffective: 45_000, newEffective: 30_000, actor, changedAt: "2026-01-01T00:00:00.000Z" },
      { id: "c4", key: "bogusKey", oldValue: 7, newValue: 1_234_567, oldEffective: 7, newEffective: 1_234_567, actor, changedAt: "2026-01-01T00:00:00.000Z" },
    ];
    setup({ data: dto({}, { changes }) });
    await loaded();
    const table = within(screen.getByRole("table", { name: "Recent changes" }));
    const rows = table.getAllByRole("row").slice(1); // 第一列是表頭
    expect(rows).toHaveLength(4);
    const text = rows.map((r) => r.textContent ?? "");
    expect(text[0]).toContain("alice@example.com");
    expect(text[0]).toContain("Note size limit");
    expect(text[0]).toContain("default (5 MiB) → 2 MiB");
    expect(text[1]).toContain("Account no longer exists");
    expect(text[1]).toContain("Parse workers");
    expect(text[1]).toContain("2 workers → auto (4 workers)");
    expect(text[2]).toContain("auto (45 seconds) → 30 seconds");
    expect(text[3]).toContain("bogusKey");
    expect(text[3]).toContain("7 → 1234567");
  });

  it("已有資料時背景重抓失敗：輸入到一半的內容與各區塊都還在，不換成錯誤", async () => {
    const server: Server = { data: dto() };
    const { queryClient } = setup(server);
    await loaded();
    fireEvent.change(field("Note size limit"), { target: { value: "3" } });
    server.failGet = true;
    await queryClient.refetchQueries({ queryKey: SITE_LIMITS_QUERY_KEY });
    await waitFor(() => expect(queryClient.getQueryState(SITE_LIMITS_QUERY_KEY)?.fetchStatus).toBe("idle"));
    expect(queryClient.getQueryState(SITE_LIMITS_QUERY_KEY)?.status).toBe("error");
    expect(field("Note size limit")).toHaveValue("3");
    expect(screen.getByRole("region", { name: "Parse workers" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("兩個分頁的 key 合起來剛好是整份註冊表、互不重疊", () => {
    const keys = [...categoryKeys("signIn"), ...PAGE_CATEGORIES.flatMap((category) => categoryKeys(category))];
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...SITE_LIMIT_KEYS].sort());
  });

  it("沒有修改紀錄 → 「還沒有修改」", async () => {
    setup({ data: dto() });
    await loaded();
    expect(screen.getByText("No changes yet.")).toBeInTheDocument();
  });
});
