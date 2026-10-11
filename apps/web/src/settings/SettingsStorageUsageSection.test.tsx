import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { StorageUsageDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SettingsStorageUsageSection } from "./SettingsStorageUsageSection";

const USER: UserDto = {
  id: "u1", email: "a@example.com", handle: "a", displayName: "A",
  isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true,
};
const MiB = 1048576;

function fakeResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function renderPage(usage: StorageUsageDto) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/storage") return Promise.resolve(fakeResponse(usage));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/auth/config")
        return Promise.resolve(fakeResponse({ providers: [], registration: { enabled: false }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SettingsStorageUsageSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (kind: string) => screen.getByTestId(`by-kind-${kind}`);
const barWidth = (kind: string) => (screen.getByTestId(`by-kind-bar-${kind}`) as HTMLElement).style.width;

describe("SettingsStorageUsageSection（#247 §5.4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("「依類型」五列恆在、順序固定（含 0 的列，W30）", async () => {
    renderPage({ usedBytes: 3 * MiB, quotaBytes: null, planName: "Big", byKind: { image: 3 * MiB, audio: 0, video: 0, document: 0, other: 0 } });
    expect(await screen.findByRole("heading", { level: 2, name: "By type" })).toBeInTheDocument();
    // 區塊標題在載入中就已渲染（列要等 /api/storage 回來）——先等列出現再數
    await screen.findByTestId("by-kind-image");
    const names = screen.getAllByTestId(/^by-kind-(image|audio|video|document|other)$/).map((el) => el.getAttribute("data-testid"));
    expect(names).toEqual(["by-kind-image", "by-kind-audio", "by-kind-video", "by-kind-document", "by-kind-other"]);
    expect(within(row("image")).getByText("Images")).toBeInTheDocument();
    expect(within(row("image")).getByText("3 MB")).toBeInTheDocument();
    expect(within(row("other")).getByText("0 B")).toBeInTheDocument();
  });

  it("佔比分母取 byKind 之和，不取 usedBytes（兩者不等時）", async () => {
    renderPage({
      usedBytes: 99 * MiB, quotaBytes: 2048 * MiB, planName: "Basic",
      byKind: { image: 3 * MiB, audio: 0, video: 0, document: 1 * MiB, other: 0 },
    });
    await screen.findByTestId("by-kind-image");
    expect(barWidth("image")).toBe("75%");
    expect(barWidth("document")).toBe("25%");
    expect(barWidth("audio")).toBe("0%");
  });

  it("五類之和為 0 → 五條都是 0%（不得 NaN）", async () => {
    renderPage({ usedBytes: 0, quotaBytes: 2048 * MiB, planName: "Basic", byKind: { image: 0, audio: 0, video: 0, document: 0, other: 0 } });
    await screen.findByTestId("by-kind-image");
    for (const kind of ["image", "audio", "video", "document", "other"]) expect(barWidth(kind)).toBe("0%");
  });

  it("頁首、用量區塊、版本歷史區塊（含「版本不佔額度」一句與自動儲存開關）", async () => {
    renderPage({ usedBytes: MiB, quotaBytes: 2048 * MiB, planName: "Basic", byKind: { image: MiB, audio: 0, video: 0, document: 0, other: 0 } });
    expect(screen.getByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Usage" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Version history" })).toBeInTheDocument();
    expect(screen.getByText("Versions and note text don't count toward storage; quotas count uploaded files only.")).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Automatic versions" })).toBeInTheDocument();
  });
});
