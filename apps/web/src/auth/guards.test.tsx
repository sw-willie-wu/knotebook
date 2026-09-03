import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import "@/i18n";
import { RequireAuth, ChangePasswordGate } from "./guards";

// `ChangePasswordGate` 的 fetch-mocked 測試：不打真的 server，只驗證
// `/api/auth/me` 回傳不同組合時，路由最終落在哪個佔位頁面。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

/** 已登入，且可指定 `mustChangePassword`——給 `ChangePasswordGate`
 * （spec rev 5.7）測試用。 */
function mockFetchMustChangePassword(mustChangePassword: boolean) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/me") {
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "u1",
              email: "a@example.com",
              displayName: "Alice",
              isAdmin: false,
              mustChangePassword,
              hasPassword: true,
            }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** 多掛一條 `/change-password` 路由，且用 `<ChangePasswordGate>` 包住 `/*`
 * catch-all——與 `App.tsx` 的真實巢狀方式一致（`/change-password` 本身在
 * gate 外面，其餘路由在 gate 裡面）。 */
function renderChangePasswordGateAt(initialPath: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<div>login-page</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/change-password" element={<div>change-password-page</div>} />
            <Route element={<ChangePasswordGate />}>
              <Route path="/*" element={<div>home-page</div>} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** `/api/auth/me` 回 500——session query 進 error 分支（401 才是「未登入」）。 */
function mockFetchServerError(): ReturnType<typeof vi.fn> {
  return vi.fn(() =>
    Promise.resolve(
      fakeResponse({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
      }),
    ),
  );
}

function renderRequireAuth(existingClient?: QueryClient) {
  const queryClient = existingClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/login" element={<div>login-page</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/*" element={<div>home-page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, unmount: view.unmount };
}

const SESSION_USER = {
  id: "u1",
  email: "a@example.com",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

function okSession(): Response {
  return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(SESSION_USER) });
}

function serverError(): Response {
  return fakeResponse({
    ok: false,
    status: 500,
    json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
  });
}

describe("session query 出錯（非 401）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("RequireAuth：500 → 顯示錯誤與重試出口，不停在 loading，也不誤導向 /login", async () => {
    vi.stubGlobal("fetch", mockFetchServerError());

    renderRequireAuth();

    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument());
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });

  /**
   * 錯誤畫面只能用在「完全沒有 session 可用」的情況。已登入之後 session query 仍會
   * 反覆重查（`main.tsx` 用裸 `new QueryClient()`＝`refetchOnWindowFocus: true` +
   * `staleTime: 0`），server 重啟或網路抖一下就會讓 `["me"]` 落入 error 狀態，但快取
   * 裡的 user 還在。
   *
   * 實測（v5.101）的兩段語意，這條測試釘的是第二段：
   * - 失敗 refetch 的**當下**，既有 observer 仍回報 `status:"success"`＋原本的 data；
   * - 但此時任何**重新掛載**（換路由、開設定 modal——`App.tsx` 兩棵 Routes 樹都掛
   *   `RequireAuth`）會建立新的 observer，它看到的是 `status:"error"` 且 data 仍在。
   *
   * 這時若把整棵樹換成錯誤畫面，代價是卸載 NotePage → `useCollab` 執行
   * `provider.destroy(); doc.destroy();`，而專案沒有 y-indexeddb，還沒同步出去的編輯
   * 就永久消失了。有 session 可用就必須沿用。
   */
  it("session 在 error 狀態但快取仍有 user → 重新掛載後照常放行，不換成錯誤畫面", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okSession()));
    vi.stubGlobal("fetch", fetchMock);

    const first = renderRequireAuth();
    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());

    fetchMock.mockImplementation(() => Promise.resolve(serverError()));
    await act(async () => {
      await first.queryClient.refetchQueries({ queryKey: ["me"] });
    });
    expect(first.queryClient.getQueryState(["me"])?.status).toBe("error"); // 前提成立
    first.unmount();

    // 同一個 QueryClient 重新掛載＝新的 observer，看到的是 error + 既有 data。
    renderRequireAuth(first.queryClient);

    expect(screen.getByText("home-page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("按下重試 → 重新查 session，這次成功就正常放行", async () => {
    let failNext = true;
    const fetchMock = vi.fn(() => {
      if (failNext) {
        failNext = false;
        return Promise.resolve(
          fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }),
        );
      }
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "u1",
              email: "a@example.com",
              displayName: "Alice",
              isAdmin: false,
              mustChangePassword: false,
              hasPassword: true,
            }),
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderRequireAuth();

    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());
  });
});

describe("ChangePasswordGate（spec rev 5.7）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mustChangePassword:true 訪 / → 導向 /change-password", async () => {
    vi.stubGlobal("fetch", mockFetchMustChangePassword(true));

    renderChangePasswordGateAt("/");

    await waitFor(() => expect(screen.getByText("change-password-page")).toBeInTheDocument());
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });

  it("mustChangePassword:false 訪 / → 不導向，正常放行", async () => {
    vi.stubGlobal("fetch", mockFetchMustChangePassword(false));

    renderChangePasswordGateAt("/");

    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());
    expect(screen.queryByText("change-password-page")).not.toBeInTheDocument();
  });

  it("mustChangePassword:true 直接訪 /change-password → 停留原地，不會被導去別處（gate 在它外面）", async () => {
    vi.stubGlobal("fetch", mockFetchMustChangePassword(true));

    renderChangePasswordGateAt("/change-password");

    await waitFor(() => expect(screen.getByText("change-password-page")).toBeInTheDocument());
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });
});

// ── #131：未登入導向登入頁時帶上 next ────────────────────────────────────────
//
// 這一族守的是「使用者本來要開的那一頁」有沒有被交給登入頁。逐字斷言整串 query 是
// 重點：pathname+search 必須恰好 encode 一次，內含的 ?、& 與 % 才不會被當成 /login
// 自己的參數（LoginPage 那頭，Task 4 起，用 searchParams.get("next") 解一次拿回原字串）。

/** 落在 /login 時把完整 location 印成單一 text node，讓斷言可以逐字 toBe。 */
function LoginProbe() {
  const location = useLocation();
  return <div data-testid="login-location">{`${location.pathname}${location.search}`}</div>;
}

/** `/api/auth/me` 回 401＝未登入（useSession 把 401 轉成 resolve null，不進 error 分支）。 */
function mockFetchUnauthenticated(): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/me") {
      return Promise.resolve(
        fakeResponse({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "unauthorized", message: "no" } }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** 讓測試可以按「上一頁」，用來分辨 replace 與 push。 */
function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      back
    </button>
  );
}

function renderRequireAuthAt(entries: string[]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route element={<RequireAuth />}>
            <Route path="/*" element={<div>protected-page</div>} />
          </Route>
        </Routes>
        <BackButton />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function expectLoginLocation(expected: string) {
  await waitFor(() => {
    expect(screen.getByTestId("login-location").textContent).toBe(expected);
  });
}

describe("#131 未登入導向帶 next", () => {
  // ⚠ 既有的兩個 `afterEach(() => vi.unstubAllGlobals())` 各自關在別的 describe 裡，
  // 這個新 describe 是它們的兄弟節點、吃不到——自己帶一份，否則 fetch 樁會外洩。
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("未登入訪問受保護路徑 → /login?next=<目前路徑>（含 query，整串 encode 一次）", async () => {
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/n/alice/my-note?a=1&b=2"]);

    await expectLoginLocation("/login?next=%2Fn%2Falice%2Fmy-note%3Fa%3D1%26b%3D2");
    expect(screen.queryByText("protected-page")).not.toBeInTheDocument();
  });

  it("pathname 本身含百分比編碼（非 ASCII 標題的真實形）→ % 要再編一次成 %25", async () => {
    // 真實瀏覽器的 location.pathname 對非 ASCII slug 就是百分比編碼形，所以這才是
    // 「/n/alice/筆記」在 web 端的樣子。**漏編**會讓 server 端 searchParams.get("next")
    // 一次就解出裸的 CJK，過不了 safeNextPath 的可見 ASCII 檢查；**雙重編碼**則會讓
    // next 變成 %252F… 開頭，解出來首字元不是 /、同樣被擋。兩種錯法都由下面這條逐字
    // 斷言接住——這一案是 Task 2 那條字元檢查在 web 端的另一端。
    // ⚠ 不可改用裸 CJK 路徑來測：MemoryRouter 不會替你編碼，那是真實瀏覽器產不出來
    // 的狀態，測出來的結論會是誤導。
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/n/alice/%E7%AD%86%E8%A8%98"]);

    await expectLoginLocation("/login?next=%2Fn%2Falice%2F%25E7%25AD%2586%25E8%25A8%2598");
  });

  it("即使 next 只是 / 也照樣寫進 URL（不特例化——少一條分支＝少一個出錯點）", async () => {
    // 代價是未登入訪首頁時網址列會多一個沒有資訊量的 ?next=%2F。這是刻意的取捨，
    // 不要「順手清乾淨」。
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/"]);

    await expectLoginLocation("/login?next=%2F");
  });

  it("hash 不帶（search 帶）", async () => {
    // 行為契約，不是機制解釋：理由見 guards.tsx 的註解（safeNextPath 那頭其實**接受**
    // 帶 fragment 的路徑，本處只是不產生它）。
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/n/alice/my-note?a=1#frag"]);

    await expectLoginLocation("/login?next=%2Fn%2Falice%2Fmy-note%3Fa%3D1");
  });

  it("導向是 replace 不是 push：登入頁按上一頁不會回到那個進不去的受保護頁", async () => {
    // 沒有這一案，把 replace 改成 push 全表仍綠——而 push 會留下一個死路：登入完
    // 按上一頁回到 /login?next=…（此時已登入）。
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    renderRequireAuthAt(["/somewhere-else", "/n/alice/my-note"]);

    await expectLoginLocation("/login?next=%2Fn%2Falice%2Fmy-note");
    fireEvent.click(screen.getByRole("button", { name: "back" }));

    // replace：受保護頁那一筆已被登入頁取代，上一頁是 /somewhere-else——它同樣未登入，
    // 於是再次被導到登入頁，next 換成 /somewhere-else。
    // 若是 push：上一頁會是 /n/alice/my-note，next 仍會是 %2Fn%2Falice%2Fmy-note。
    await expectLoginLocation("/login?next=%2Fsomewhere-else");
  });

  it("ChangePasswordGate 獨立掛載＋未登入 → 同樣帶 next（三顆 gate 共用 useSessionGate）", async () => {
    vi.stubGlobal("fetch", mockFetchUnauthenticated());

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/settings/account"]}>
          <Routes>
            <Route path="/login" element={<LoginProbe />} />
            <Route element={<ChangePasswordGate />}>
              <Route path="/*" element={<div>protected-page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await expectLoginLocation("/login?next=%2Fsettings%2Faccount");
  });
});
