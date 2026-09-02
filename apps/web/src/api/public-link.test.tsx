import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreatePublicLink, useDeletePublicLink, type PublicLinkDto } from "./public-link";

/**
 * #122 PR3 Task 2：public-link 快取的兩個 mutation 寫入點（plan gate M4／r5-m1 的
 * 故障形——這兩點寫錯不會讓任何 render 測試紅，只會讓 ShareDialog 的公開連結列或
 * 別名列「憑空消失/殘留」）：
 * - 撤公開（DELETE）：204 無 body，快取必須寫 `{token: null, slug: null}` **兩鍵**
 *   ——漏 slug＝撤公開後別名殘留畫面。
 * - 重生（PUT）：onSuccess 直寫 server 回應——server 回全形 `{token, slug}`，快取
 *   的 slug 必須保留原別名而非變 undefined。
 */

const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const KEY = ["public-link", NOTE_ID];

function fakeResponse(status: number, json?: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: () => (json === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(json)),
  } as unknown as Response;
}

function Harness() {
  const create = useCreatePublicLink(NOTE_ID);
  const del = useDeletePublicLink(NOTE_ID);
  return (
    <div>
      <button onClick={() => create.mutate()}>put</button>
      <button onClick={() => del.mutate()}>del</button>
    </div>
  );
}

function setup(fetchImpl: (method: string) => Response) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // 種既有狀態：token＋別名都在（分享面板已開過的形）
  queryClient.setQueryData(KEY, { token: "T".repeat(43), slug: "my-alias" } satisfies PublicLinkDto);
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(fetchImpl((init?.method ?? "GET").toUpperCase())),
    ),
  );
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public-link 快取寫入點（#122 PR3）", () => {
  it("撤公開（DELETE 204 無 body）→ 快取寫 {token: null, slug: null} 兩鍵——別名不殘留", async () => {
    const { queryClient, getByText } = setup(() => fakeResponse(204));
    fireEvent.click(getByText("del"));
    await waitFor(() => {
      expect(queryClient.getQueryData(KEY)).toEqual({ token: null, slug: null });
    });
  });

  it("重生（PUT 回全形）→ 快取直寫回應，slug 保留原別名、token 換新", async () => {
    const NEW_TOKEN = "U".repeat(43);
    const { queryClient, getByText } = setup((method) =>
      method === "PUT" ? fakeResponse(200, { token: NEW_TOKEN, slug: "my-alias" }) : fakeResponse(500),
    );
    fireEvent.click(getByText("put"));
    await waitFor(() => {
      expect(queryClient.getQueryData(KEY)).toEqual({ token: NEW_TOKEN, slug: "my-alias" });
    });
  });
});
