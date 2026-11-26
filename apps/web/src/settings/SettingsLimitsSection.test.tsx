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

describe("SettingsLimitsSection (site limits tab)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("grouped by category into three groups (batch read/write has no items so isn't drawn, the two sign-in items aren't on this page), the recent changes last", async () => {
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
    expect(block("Uploads and notes").getAllByRole("group").map((g) => g.getAttribute("data-limit-key"))).toEqual(["uploadMaxBytes", "uploadMediaMaxMib", "noteMaxBytes"]);
    expect(block("Parse workers").getAllByRole("group").map((g) => g.getAttribute("data-limit-key"))).toEqual([
      "parseWorkers",
      "parseWorkerMemoryMb",
      "parseTimeoutMs",
      "parseQueueWaitMs",
    ]);
    expect(block("Rate limits").getAllByRole("group")).toHaveLength(9);
  });

  it("every row shows its default and range; rate-limit rows add the window (per minute / per 10 minutes / per hour)", async () => {
    setup({ data: dto() });
    await loaded();
    expect(row("Note size limit").getByText("Default 5 MiB · Range 1–5 MiB")).toBeInTheDocument();
    expect(row("Parse time limit").getByText("Default 10 seconds · Range 4–10 seconds")).toBeInTheDocument();
    expect(row("Number of parse workers").getByText("Default auto · Range 1–4 workers")).toBeInTheDocument();
    expect(row("API and MCP reads").getByText("Default 300 times · Range 30–300 times · per minute")).toBeInTheDocument();
    expect(row("API and MCP writes").getByText("Default 60 times · Range 6–60 times · per 10 minutes")).toBeInTheDocument();
    expect(row("Bulk downloads").getByText("Default 10 times · Range 1–10 times · per hour")).toBeInTheDocument();
  });

  it("Chinese: the default / range text and the \"every N minutes\" wording", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ data: dto() });
    await screen.findByLabelText("筆記大小上限", { selector: "input" });
    expect(within(screen.getByRole("group", { name: "筆記大小上限" })).getByText("預設 5 MiB · 範圍 1–5 MiB")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "API／MCP 寫入次數" })).getByText("預設 60 次 · 範圍 6–60 次 · 每 10 分鐘")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "解析 worker 數" })).getByText("預設 自動 · 範圍 1–4 個")).toBeInTheDocument();
  });

  it("env item: the input is disabled with the .env note; a value in range but not aligned is shown as bytes as-is, not marked out of range", async () => {
    setup({ data: dto({ noteMaxBytes: { value: 3_145_729, source: "env", locked: true } }) });
    await loaded();
    expect(field("Note size limit")).toBeDisabled();
    expect(field("Note size limit")).toHaveValue("3 145 729 bytes");
    expect(row("Note size limit").getByText("Set by NOTE_MAX_BYTES in .env. To change it, edit .env and restart the server.")).toBeInTheDocument();
    expect(row("Note size limit").queryByText("Outside the range this page can set.")).not.toBeInTheDocument();
    expect(row("Note size limit").queryByText(/is not applied/)).not.toBeInTheDocument();
    expect(row("Note size limit").queryByText("MiB")).not.toBeInTheDocument(); // the original text already carries the unit, so no MiB label beside the box
    expect(field("Note size limit")).toHaveAccessibleDescription(/Set by NOTE_MAX_BYTES in \.env/);
  });

  it("env value 5242881 out of range and not aligned -> raw bytes (digit-grouped) plus \"out of the range adjustable on the admin page\"", async () => {
    setup({ data: dto({ noteMaxBytes: { value: 5_242_881, source: "env", locked: true } }) });
    await loaded();
    expect(field("Note size limit")).toHaveValue("5 242 881 bytes");
    expect(row("Note size limit").getByText("Outside the range this page can set.")).toBeInTheDocument();
    expect(field("Note size limit")).toHaveAccessibleDescription(/Outside the range this page can set\./);
  });

  it("Chinese: an unaligned env value is also space-grouped and shown in API units", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ data: dto({ noteMaxBytes: { value: 5_242_881, source: "env", locked: true }, parseTimeoutMs: { value: 12_345, source: "env", locked: true } }) });
    await screen.findByLabelText("筆記大小上限", { selector: "input" });
    expect(screen.getByLabelText("筆記大小上限", { selector: "input" })).toHaveValue("5 242 881 bytes");
    expect(screen.getByLabelText("解析時限", { selector: "input" })).toHaveValue("12 345 ms");
    expect(within(screen.getByRole("group", { name: "筆記大小上限" })).getByText("超出管理頁可調範圍。")).toBeInTheDocument();
  });

  it("env value 104857600 aligned but out of range -> shown as 100 MiB in the input unit plus \"out of the range adjustable on the admin page\"", async () => {
    setup({ data: dto({ noteMaxBytes: { value: 104_857_600, source: "env", locked: true } }) });
    await loaded();
    expect(field("Note size limit")).toHaveValue("100");
    expect(row("Note size limit").getByText("MiB")).toBeInTheDocument();
    expect(row("Note size limit").getByText("Outside the range this page can set.")).toBeInTheDocument();
  });

  it("env worker count 8 (env may give it, beyond the admin page's range) -> shows 8, unit is workers, marked out of range", async () => {
    setup({ data: dto({ parseWorkers: { value: 8, source: "env", locked: true } }) });
    await loaded();
    expect(field("Number of parse workers")).toHaveValue("8");
    expect(row("Number of parse workers").getByText("workers")).toBeInTheDocument();
    expect(row("Number of parse workers").queryByText("times")).not.toBeInTheDocument();
    expect(row("Number of parse workers").getByText("Outside the range this page can set.")).toBeInTheDocument();
  });

  it("units are singular/plural: when the value is 1 the label beside the box is singular", async () => {
    setup({ data: dto({ parseWorkers: { value: 1, source: "admin", stored: 1 }, rateTransferExport: { value: 1, source: "admin", stored: 1 } }) });
    await loaded();
    expect(row("Number of parse workers").getByText("worker")).toBeInTheDocument();
    expect(row("Bulk downloads").getByText("time")).toBeInTheDocument();
    fireEvent.change(field("Number of parse workers"), { target: { value: "3" } });
    expect(row("Number of parse workers").getByText("workers")).toBeInTheDocument();
  });

  it("env-locked but the admin page also stored a value -> \"the value X stored on the admin page won't take effect\"", async () => {
    setup({ data: dto({ parseTimeoutMs: { value: 12_345, source: "env", locked: true, stored: 8_000 } }) });
    await loaded();
    expect(field("Parse time limit")).toHaveValue("12 345 ms");
    expect(row("Parse time limit").getByText("Set by PARSE_TIMEOUT_MS in .env. To change it, edit .env and restart the server.")).toBeInTheDocument();
    expect(row("Parse time limit").getByText("The value saved on this page (8 seconds) is not applied.")).toBeInTheDocument();
  });

  it("when the env value is aligned it's shown in the input unit", async () => {
    setup({ data: dto({ parseWorkerMemoryMb: { value: 2_048, source: "env", locked: true } }) });
    await loaded();
    expect(field("Memory per worker")).toHaveValue("2048");
    expect(field("Memory per worker")).toBeDisabled();
    expect(row("Memory per worker").queryByRole("button")).not.toBeInTheDocument();
  });

  it("auto item: input blank, placeholder is the auto value, labelled \"auto: N (by CPU)\"", async () => {
    setup({ data: dto() });
    await loaded();
    expect(field("Number of parse workers")).toHaveValue("");
    expect(field("Number of parse workers")).toHaveAttribute("placeholder", "4");
    expect(row("Number of parse workers").getByText("Auto: 4 (based on CPUs)")).toBeInTheDocument();
    expect(field("Longest wait for a worker")).toHaveValue("");
    expect(field("Longest wait for a worker")).toHaveAttribute("placeholder", "45");
    expect(row("Longest wait for a worker").getByText("Auto: 45 seconds")).toBeInTheDocument();
    expect(field("Number of parse workers")).toHaveAccessibleDescription(/Auto: 4 \(based on CPUs\)/);
  });

  it("auto value not aligned to the input step -> no placeholder, the raw value is written in \"auto: ...\"", async () => {
    setup({ data: dto({ parseQueueWaitMs: { value: 54_380, autoValue: 54_380 } }) });
    await loaded();
    expect(field("Longest wait for a worker")).not.toHaveAttribute("placeholder");
    expect(row("Longest wait for a worker").getByText("Auto: 54 380 ms")).toBeInTheDocument();
  });

  it("auto item by memory -> \"by memory\"", async () => {
    setup({ data: dto({ parseWorkers: { value: 2, autoValue: 2, autoSource: "memory" } }) });
    await loaded();
    expect(row("Number of parse workers").getByText("Auto: 2 (based on memory)")).toBeInTheDocument();
  });

  it("storedIgnored -> \"stored value X is out of the current range, not applied\"", async () => {
    setup({ data: dto({ uploadMaxBytes: { stored: 20 * 1_048_576, storedIgnored: true } }) });
    await loaded();
    expect(row("Upload size limit").getByText("The saved value 20 MiB is outside the current range and is not applied.")).toBeInTheDocument();
    expect(field("Upload size limit")).toHaveValue("10");
  });

  it("typing 0.5, 1.5, blank (non-auto item) -> inline error, no PATCH", async () => {
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

  it("out of range -> \"enter an integer from A to B\" (input unit), no PATCH", async () => {
    const { patches } = setup({ data: dto() });
    await loaded();
    fireEvent.change(field("Note size limit"), { target: { value: "6" } });
    fireEvent.click(block("Uploads and notes").getByRole("button", { name: "Save" }));
    expect(await row("Note size limit").findByRole("alert")).toHaveTextContent("Enter a whole number from 1 to 5.");
    await tick();
    expect(patches()).toEqual([]);
  });

  it("auto item: typed a value then cleared -> that key isn't sent, no error; only changed keys are sent (in API units)", async () => {
    const { patches } = setup({ data: dto() });
    await loaded();
    fireEvent.change(field("Number of parse workers"), { target: { value: "2" } });
    fireEvent.change(field("Number of parse workers"), { target: { value: "" } });
    fireEvent.change(field("Parse time limit"), { target: { value: "8" } });
    fireEvent.click(block("Parse workers").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { parseTimeoutMs: 8_000 } }]));
    expect(block("Parse workers").queryByRole("alert")).not.toBeInTheDocument();
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("an adjusted auto item cleared then saved -> sends null (back to auto), no validation error", async () => {
    const { patches } = setup({ data: dto({ parseWorkers: { value: 2, source: "admin", stored: 2 } }) });
    await loaded();
    expect(field("Number of parse workers")).toHaveValue("2");
    fireEvent.change(field("Number of parse workers"), { target: { value: "" } });
    fireEvent.click(block("Parse workers").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { parseWorkers: null } }]));
    expect(block("Parse workers").queryByRole("alert")).not.toBeInTheDocument();
  });

  it("each section saves on its own: change two sections, pressing one sends only that section's keys; unchanged values aren't sent", async () => {
    const { patches } = setup({ data: dto() });
    await loaded();
    fireEvent.change(field("Note content writes"), { target: { value: "20" } });
    fireEvent.change(field("AI actions"), { target: { value: "29" } });
    fireEvent.change(field("AI actions"), { target: { value: "30" } }); // changed back to the same as the current value
    fireEvent.change(field("Note size limit"), { target: { value: "2" } });
    fireEvent.click(block("Rate limits").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { rateEdit: 20 } }]));
  });

  it("auto item with a value typed -> sends that value", async () => {
    const { patches } = setup({ data: dto() });
    await loaded();
    fireEvent.change(field("Number of parse workers"), { target: { value: "2" } });
    fireEvent.click(block("Parse workers").getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { parseWorkers: 2 } }]));
  });

  it("adjusted: marked \"adjusted\"; \"restore default\" sends null; an auto item's button is \"back to auto\"", async () => {
    const { patches } = setup({
      data: dto({
        rateSearch: { value: 30, source: "admin", stored: 30 },
        parseWorkers: { value: 2, source: "admin", stored: 2 },
      }),
    });
    await loaded();
    expect(row("Searches").getByText("Adjusted")).toBeInTheDocument();
    expect(field("Searches")).toHaveValue("30");
    expect(row("Number of parse workers").queryByRole("button", { name: "Restore default" })).not.toBeInTheDocument();
    expect(row("Note size limit").queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(row("Searches").getByRole("button", { name: "Restore default" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { rateSearch: null } }]));
    fireEvent.click(row("Number of parse workers").getByRole("button", { name: "Back to auto" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { rateSearch: null } }, { set: { parseWorkers: null } }]));
  });

  it("\"restore default\" success clears that row's earlier validation error", async () => {
    const { patches } = setup({ data: dto({ rateSearch: { value: 30, source: "admin", stored: 30 } }) });
    await loaded();
    fireEvent.change(field("Searches"), { target: { value: "abc" } });
    fireEvent.click(block("Rate limits").getByRole("button", { name: "Save" }));
    expect(await row("Searches").findByRole("alert")).toHaveTextContent("Enter a whole number.");
    fireEvent.click(row("Searches").getByRole("button", { name: "Restore default" }));
    await waitFor(() => expect(patches()).toEqual([{ set: { rateSearch: null } }]));
    await waitFor(() => expect(row("Searches").queryByRole("alert")).not.toBeInTheDocument());
  });

  it("server returns 409 limit_locked_by_env -> that text shows at the top of the section", async () => {
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

  it("server returns 400 -> \"value is not in the adjustable range\", the English message isn't shown", async () => {
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

  describe("memory warning", () => {
    const WARNING = /^May exceed memory/;
    const twoGiB = (cpus: number) =>
      dto(
        { parseWorkers: { value: 1, autoValue: 1, autoSource: "memory" } },
        { machine: { cpus, cpuSource: "os", memoryBytes: 2 * GiB, memorySource: "os" } },
      );

    it("worker count auto, memory limit changed to 512 -> uses the recomputed N = 2 -> 2788.8 MB > 2048 -> appears; still savable", async () => {
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

    it("same but 2 CPUs -> N = 1 -> 1994.4 MB <= 2048 -> doesn't appear; still savable", async () => {
      const { patches } = setup({ data: twoGiB(2) });
      await loaded();
      expect(block("Parse workers").getByText(WARNING)).toHaveTextContent("about 2609 MB needed (1 worker × (1024 + 150) MB + 1000 MB, plus 20%)");
      fireEvent.change(field("Memory per worker"), { target: { value: "512" } });
      expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
      const save = block("Parse workers").getByRole("button", { name: "Save" });
      expect(save).not.toBeDisabled();
      fireEvent.click(save);
      await waitFor(() => expect(patches()).toEqual([{ set: { parseWorkerMemoryMb: 512 } }]));
    });
  });

  it("the parse time limit, memory and queue wait rows have notes about the consequences of lowering", async () => {
    setup({ data: dto() });
    await loaded();
    expect(row("Parse time limit").getByText(/^Lowering this may reject writes of densely formatted content/)).toBeInTheDocument();
    expect(row("Memory per worker").getByText(/^Lowering this may reject densely formatted content \(measured at 640–768 MiB\)/)).toBeInTheDocument();
    expect(row("Longest wait for a worker").getByText(/^If this is shorter than 4 × the parse time limit \+ 5 seconds/)).toBeInTheDocument();
    expect(row("Number of parse workers").queryByText(/^Lowering this/)).not.toBeInTheDocument();
    expect(row("Note size limit").queryByText(/^Lowering this/)).not.toBeInTheDocument();
  });

  it("top of the parse worker section: CPU count, GiB and memory source all come from machine (en / zh verbatim)", async () => {
    setup({ data: dto({}, { machine: { cpus: 8, cpuSource: "os", memoryBytes: 16 * GiB, memorySource: "cgroup-v2" } }) });
    await loaded();
    expect(block("Parse workers").getByText("This server: 8 CPUs, 16 GiB memory (cgroup-v2)")).toBeInTheDocument();
    expect(screen.queryByText(/^May exceed memory/)).not.toBeInTheDocument(); // 4 x (1024 + 150) + 1000 plus 20% is far below 16 GiB
  });

  it("only 1 CPU -> singular \"1 CPU\"", async () => {
    setup({ data: dto({}, { machine: { cpus: 1, cpuSource: "os", memoryBytes: 16 * GiB, memorySource: "os" } }) });
    await loaded();
    expect(block("Parse workers").getByText("This server: 1 CPU, 16 GiB memory (os)")).toBeInTheDocument();
  });

  it("the description text and the \"after lowering...\" note are both attached via the input's aria-describedby; the memory warning is a status", async () => {
    setup({ data: dto({ parseWorkers: { value: 1, autoValue: 1, autoSource: "memory" } }, { machine: { cpus: 8, cpuSource: "os", memoryBytes: 2 * GiB, memorySource: "os" } }) });
    await loaded();
    expect(field("Memory per worker")).toHaveAccessibleDescription(/Memory each worker may use./);
    expect(field("Memory per worker")).toHaveAccessibleDescription(/Lowering this may reject densely formatted content/);
    fireEvent.change(field("Memory per worker"), { target: { value: "512" } });
    expect(block("Parse workers").getByRole("status")).toHaveTextContent(/^May exceed memory/);
  });

  it("top of the parse worker section (zh)", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ data: dto({}, { machine: { cpus: 6, cpuSource: "os", memoryBytes: 12 * GiB, memorySource: "cgroup-v1" } }) });
    await screen.findByLabelText("筆記大小上限", { selector: "input" });
    expect(screen.getByText("這台伺服器：6 個 CPU、12 GiB 記憶體（cgroup-v1）")).toBeInTheDocument();
  });

  it("change log table: accounts that no longer exist, default (X) / auto (X), input units; keys not in the registry are listed as is", async () => {
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
    const rows = table.getAllByRole("row").slice(1); // the first row is the header
    expect(rows).toHaveLength(4);
    const text = rows.map((r) => r.textContent ?? "");
    expect(text[0]).toContain("alice@example.com");
    expect(text[0]).toContain("Note size limit");
    expect(text[0]).toContain("default (5 MiB) → 2 MiB");
    expect(text[1]).toContain("Account no longer exists");
    expect(text[1]).toContain("Number of parse workers");
    expect(text[1]).toContain("2 workers → auto (4 workers)");
    expect(text[2]).toContain("auto (45 seconds) → 30 seconds");
    expect(text[3]).toContain("bogusKey");
    expect(text[3]).toContain("7 → 1234567");
  });

  it("background refetch fails when data already exists: half-typed input and all sections remain, no switch to an error", async () => {
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

  it("the keys of the two tabs together are exactly the whole registry, with no overlap", () => {
    const keys = [...categoryKeys("signIn"), ...PAGE_CATEGORIES.flatMap((category) => categoryKeys(category))];
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...SITE_LIMIT_KEYS].sort());
  });

  it("no change log -> \"no changes yet\"", async () => {
    setup({ data: dto() });
    await loaded();
    expect(screen.getByText("No changes yet.")).toBeInTheDocument();
  });
});
