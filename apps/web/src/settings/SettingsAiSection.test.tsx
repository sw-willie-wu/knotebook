import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminAiActionDto, AdminAiModelDto, AdminAiProviderDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SettingsAiSection } from "./SettingsAiSection";

// 同一套約定：mock 全域 fetch，讓真正的 admin-ai hooks（`@/api/adminAi`，react-query）
// 打到假回應，不 mock hook 本身——見 ShareDialog.test.tsx/NoteList.test.tsx 的說明。
// `SettingsAiSection` 本身不吃任何 router/session context（不像 `SettingsUsersSection`
// 需要 `useSession` 判斷「自己那列」），直接單獨渲染即可，不必透過 `AppRoutes`。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const PROVIDER_A: AdminAiProviderDto = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Anthropic Prod",
  type: "anthropic",
  baseUrl: "https://api.anthropic.com",
  enabled: true,
  hasKey: true,
  degraded: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PROVIDER_B: AdminAiProviderDto = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Local Ollama",
  type: "openai_compatible",
  baseUrl: "http://host:11434/v1",
  enabled: true,
  hasKey: false,
  degraded: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const MODEL_A1: AdminAiModelDto = {
  id: "33333333-3333-3333-3333-333333333333",
  providerId: PROVIDER_A.id,
  modelId: "claude-3-5-sonnet",
  displayName: "Claude Sonnet",
  purpose: "chat",
  isDefault: true,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const MODEL_B1: AdminAiModelDto = {
  id: "44444444-4444-4444-4444-444444444444",
  providerId: PROVIDER_B.id,
  modelId: "llama3",
  displayName: "Llama 3",
  purpose: "chat",
  isDefault: false,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const ACTION_BUILTIN: AdminAiActionDto = {
  id: "55555555-5555-5555-5555-555555555555",
  name: "Improve writing",
  systemPrompt: "You are a helpful writing assistant.",
  userTemplate: "Improve the following text:\n{{text}}",
  modelId: null,
  applyMode: "direct",
  sortOrder: 0,
  enabled: true,
  builtin: true,
};

const ACTION_CUSTOM: AdminAiActionDto = {
  id: "66666666-6666-6666-6666-666666666666",
  name: "Custom action",
  systemPrompt: "You are a helpful assistant.",
  userTemplate: "Do something with:\n{{text}}",
  modelId: null,
  applyMode: "preview",
  sortOrder: 1,
  enabled: true,
  builtin: false,
};

/** 三層 GET 端點的假回應——`overrides` 讓每案覆寫任一層清單，其餘沿用預設 fixture。 */
function defaultGetHandlers(
  overrides: Partial<{ providers: AdminAiProviderDto[]; models: AdminAiModelDto[]; actions: AdminAiActionDto[] }> = {},
) {
  const providers = overrides.providers ?? [PROVIDER_A, PROVIDER_B];
  const models = overrides.models ?? [MODEL_A1, MODEL_B1];
  const actions = overrides.actions ?? [ACTION_BUILTIN, ACTION_CUSTOM];
  return (url: string, method: string): Response | null => {
    if (url === "/api/admin/ai/providers" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers }) });
    }
    if (url === "/api/admin/ai/models" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ models }) });
    }
    if (url === "/api/admin/ai/actions" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ actions }) });
    }
    return null;
  };
}

function renderSection(
  fetchMock: ReturnType<typeof vi.fn>,
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsAiSection />
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("SettingsAiSection（spec §13.4：provider／model／action 三層 CRUD）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("三層列表渲染：providers／內嵌 models／actions", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers()(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    expect(screen.getByText(PROVIDER_B.name)).toBeInTheDocument();
    expect(screen.getByText(MODEL_A1.displayName)).toBeInTheDocument();
    expect(screen.getByText(MODEL_A1.modelId)).toBeInTheDocument();
    expect(screen.getByText(MODEL_B1.displayName)).toBeInTheDocument();
    expect(screen.getByText(ACTION_BUILTIN.name)).toBeInTheDocument();
    expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument();
  });

  it("新增 provider（含 apiKey）送出 camelCase body", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/providers" && method === "POST") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ ...PROVIDER_A, id: "p-new" }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText("No providers yet.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.anthropic.com" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) => String(reqUrl) === "/api/admin/ai/providers" && (reqInit as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        name: "New Provider",
        type: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-test-123",
      });
    });
  });

  it("apiKey 已設 → edit dialog 顯示覆寫 placeholder；留空送出 PATCH 不含 apiKey 欄位", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/providers/${PROVIDER_A.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(PROVIDER_A) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const apiKeyInput = await screen.findByLabelText("API key");
    expect(apiKeyInput).toHaveAttribute("placeholder", "Already set — enter a new value to overwrite");
    expect(apiKeyInput).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) =>
          String(reqUrl) === `/api/admin/ai/providers/${PROVIDER_A.id}` && (reqInit as RequestInit | undefined)?.method === "PATCH",
      );
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("apiKey");
      expect(body).toEqual({ name: PROVIDER_A.name, type: PROVIDER_A.type, baseUrl: PROVIDER_A.baseUrl });
    });
  });

  it("degraded provider 顯示警示與重輸提示", async () => {
    const degradedProvider: AdminAiProviderDto = { ...PROVIDER_A, degraded: true };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [degradedProvider], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(degradedProvider.name)).toBeInTheDocument());
    expect(screen.getByText(/Degraded/)).toBeInTheDocument();
    expect(screen.getByText(/Enter the API key again to restore it/)).toBeInTheDocument();
  });

  it("測試連線失敗 → 仍 invalidate（fix round 1 m-1：onSettled，不是 onSuccess——degraded 徽章不過期）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/providers/${PROVIDER_A.id}/test` && method === "POST") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 503,
            json: () => Promise.resolve({ error: { code: "provider_unavailable", message: "此 provider 目前無法使用" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderSection(fetchMock, queryClient);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    // 失敗訊息本身也要顯示（既有的錯誤處理路徑）。
    await waitFor(() => expect(screen.getByText("AI provider is unavailable — ask an admin to re-enter the API key")).toBeInTheDocument());

    // 重點：mutation 失敗仍要 invalidate（server 端只在失敗路徑對 runtime.degraded
    // 做 add，若沿用 onSuccess，剛變 degraded 的卡片直到下一次無關操作前都不會刷新）。
    const keys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["admin-ai"]);
    expect(keys).toContainEqual(["ai-actions"]);
  });

  it("model isDefault 顯示星號徽章", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [MODEL_A1], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(MODEL_A1.displayName)).toBeInTheDocument());
    expect(screen.getByTitle("Default")).toHaveTextContent("★");
  });

  it("409 model_taken → model 表單顯示錯誤文案", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/models" && method === "POST") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: { code: "model_taken", message: "此 provider 已有相同 model" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));

    await waitFor(() => expect(screen.getByLabelText("Model ID")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "claude-3-5-sonnet" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Dup" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText("This model already exists for the provider")).toBeInTheDocument());
  });

  it("builtin action 無刪除鈕、自訂 action 有", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_BUILTIN, ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_BUILTIN.name)).toBeInTheDocument());
    const builtinRow = screen.getByText(ACTION_BUILTIN.name).closest("li");
    const customRow = screen.getByText(ACTION_CUSTOM.name).closest("li");
    expect(builtinRow).not.toBeNull();
    expect(customRow).not.toBeNull();
    expect(builtinRow && within(builtinRow).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(customRow && within(customRow).queryByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("userTemplate 缺 {{text}} → 400 invalid_body，表單顯示錯誤", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/actions" && method === "POST") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ error: { code: "invalid_body", message: "userTemplate 必須包含 {{text}} 佔位符" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText("No actions yet.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bad action" } });
    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "You are helpful." } });
    fireEvent.change(screen.getByLabelText("User template"), { target: { value: "Rewrite this without placeholder" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText("The request was malformed.")).toBeInTheDocument());
  });

  it("新增 action 附加在清單最後：create body 帶遞增 sortOrder（fix round 1 M-1 回歸釘）", async () => {
    // ACTION_BUILTIN.sortOrder=0、ACTION_CUSTOM.sortOrder=1——修法前 create body 省略
    // `sortOrder`，server 端 `sortOrder ?? 0` 會讓新動作跟 ACTION_BUILTIN 同分變成 0，
    // 之後上下移鈕互換同分值＝原地不動，排序對這個新動作靜默失效。這裡直接斷言送出的
    // POST body 帶的是 `max(0,1)+1=2`，不是被省略、也不是 0。
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_BUILTIN, ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/actions" && method === "POST") {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 201,
            json: () => Promise.resolve({ ...ACTION_CUSTOM, id: "a-new", name: "New action", sortOrder: 2 }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New action" } });
    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "You are helpful." } });
    fireEvent.change(screen.getByLabelText("User template"), { target: { value: "Do something with:\n{{text}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) => String(reqUrl) === "/api/admin/ai/actions" && (reqInit as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.sortOrder).toBe(2);
      // 明確不是修法前的行為：省略欄位、或跟 ACTION_BUILTIN 同分變 0。
      expect(body.sortOrder).not.toBe(ACTION_BUILTIN.sortOrder);
      expect(body).toHaveProperty("sortOrder");
    });
  });

  it("上下移鈕：PATCH sortOrder 對調", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_BUILTIN, ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/actions/${ACTION_BUILTIN.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ACTION_BUILTIN) }));
      }
      if (url === `/api/admin/ai/actions/${ACTION_CUSTOM.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ACTION_CUSTOM) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: `Move up ${ACTION_CUSTOM.name}` }));

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([, reqInit]) => (reqInit as RequestInit | undefined)?.method === "PATCH");
      expect(patchCalls).toHaveLength(2);
    });

    const patchCalls = fetchMock.mock.calls.filter(([, reqInit]) => (reqInit as RequestInit | undefined)?.method === "PATCH");
    const [firstUrl, firstInit] = patchCalls[0] as [RequestInfo, RequestInit];
    const [secondUrl, secondInit] = patchCalls[1] as [RequestInfo, RequestInit];
    expect(String(firstUrl)).toBe(`/api/admin/ai/actions/${ACTION_CUSTOM.id}`);
    expect(JSON.parse(String(firstInit.body))).toEqual({ sortOrder: ACTION_BUILTIN.sortOrder });
    expect(String(secondUrl)).toBe(`/api/admin/ai/actions/${ACTION_BUILTIN.id}`);
    expect(JSON.parse(String(secondInit.body))).toEqual({ sortOrder: ACTION_CUSTOM.sortOrder });
  });

  it("上下移鈕：mutation 進行中連點是 no-op，不送出第二組 PATCH（fix round 2 回歸釘）", async () => {
    // 修法前上下移鈕只看 `!canMoveUp/Down`，沒鎖 in-flight——連點會用同一份 stale
    // `actions` 陣列各自送出「跟相鄰項目對調」的第二組 PATCH，兩次對調彼此抵銷造成
    // 兩列同 `sortOrder`（Edit 表單不送這個欄位救不回來）。這裡把第一支 PATCH 卡住不
    // resolve，模擬「使用者在按鈕變 disabled 前又點了一次」，斷言全程只送出原本那
    // 一組（2 支）PATCH，不會因為第二次點擊多出第二組。
    let resolveFirstPatch!: (value: Response) => void;
    const firstPatchPromise = new Promise<Response>((resolve) => {
      resolveFirstPatch = resolve;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_BUILTIN, ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/actions/${ACTION_CUSTOM.id}` && method === "PATCH") {
        return firstPatchPromise;
      }
      if (url === `/api/admin/ai/actions/${ACTION_BUILTIN.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ACTION_BUILTIN) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument());
    const moveUpButton = screen.getByRole("button", { name: `Move up ${ACTION_CUSTOM.name}` });

    fireEvent.click(moveUpButton);
    await waitFor(() => expect(moveUpButton).toBeDisabled());

    // 第一支 PATCH 還卡著沒 resolve——按鈕此時應該已經 disabled，這次點擊要是 no-op。
    fireEvent.click(moveUpButton);

    resolveFirstPatch(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ACTION_CUSTOM) }));

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([, reqInit]) => (reqInit as RequestInit | undefined)?.method === "PATCH");
      expect(patchCalls).toHaveLength(2);
    });

    // 給第二支（鄰居項）PATCH 一輪 microtask 機會送出並讓 mutateAsync 鏈 settle，
    // 確認全程真的只有 2 支，不是因為斷言時機太早而漏數。
    await waitFor(() => expect(moveUpButton).not.toBeDisabled());
    const patchCalls = fetchMock.mock.calls.filter(([, reqInit]) => (reqInit as RequestInit | undefined)?.method === "PATCH");
    expect(patchCalls).toHaveLength(2);
  });

  it("任一 mutation 成功 → invalidate ['admin-ai'] 前綴與 ['ai-actions']", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/providers/${PROVIDER_A.id}` && method === "PATCH") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...PROVIDER_A, enabled: false }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderSection(fetchMock, queryClient);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Enabled"));

    await waitFor(() => {
      const keys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
      expect(keys).toContainEqual(["admin-ai"]);
      expect(keys).toContainEqual(["ai-actions"]);
    });
  });
});
