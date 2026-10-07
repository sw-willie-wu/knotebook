import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MAX_PROVIDER_ICON_SOURCE_BYTES, type AdminAuthProviderDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ADMIN_AUTH_PROVIDERS_QUERY_KEY } from "@/api/adminAuth";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
import { clickOutside, settle } from "@/test/outside-click";
import { ProviderIconDialog } from "./ProviderIconDialog";

const ID = "44444444-4444-4444-8444-444444444444";
const BASE: AdminAuthProviderDto = {
  id: ID,
  template: "gitlab",
  displayName: "Corp GitLab",
  issuerUrl: "https://gitlab.example.com",
  clientId: "corp",
  hasSecret: true,
  enabled: true,
  sortOrder: 0,
  legacyCallback: false,
  callbackUrl: `https://notes.example.com/api/auth/oidc/callback/${ID}`,
  insecureIssuer: false,
  issuerResolved: true,
  createdAt: "2026-10-07T00:00:00.000Z",
  iconKind: "template",
  icon: { type: "builtin", name: "gitlab" },
};
const UPLOADED_URL = `/api/auth/providers/${ID}/icon?v=2`;
const UPLOADED: AdminAuthProviderDto = { ...BASE, iconKind: "upload", icon: { type: "upload", url: UPLOADED_URL } };
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}

interface Call { method: string; url: string; body: unknown }

/** jsdom 沒有 createImageBitmap 與 canvas：stub 全域與 prototype，讓**真的** `resizeProviderIcon` 跑（型別／大小檢查與縮圖都經它）。 */
function stubDecoder(result: { width: number; height: number } | "fail") {
  const createImageBitmap = vi.fn(async () => {
    if (result === "fail") throw new Error("decode failed");
    return { ...result, close: vi.fn() } as unknown as ImageBitmap;
  });
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage, imageSmoothingQuality: "low" } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback) => cb(new Blob([PNG_MAGIC], { type: "image/png" })));
  return { createImageBitmap, drawImage };
}

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

/** provider 來自 useQuery（同 AdminAuthPage 的卡片接線）：mutation 的 invalidate 會讓 prop 隨之更新。 */
function LiveDialog({ fallback }: { fallback: AdminAuthProviderDto }) {
  const { data } = useQuery({
    queryKey: ADMIN_AUTH_PROVIDERS_QUERY_KEY,
    queryFn: async () => (await (await fetch("/api/admin/auth/providers")).json()) as AdminAuthProviderDto[],
  });
  return <ProviderIconDialog provider={data?.[0] ?? fallback} />;
}

function setup(
  provider: AdminAuthProviderDto,
  respond: (call: Call) => Response | Promise<Response> = () => fakeResponse(200, provider),
  live = false,
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body };
      calls.push(call);
      return respond(call);
    }),
  );
  let n = 0;
  const createObjectURL = vi.fn(() => `blob:icon-${++n}`);
  const revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 兩個 key 先進 cache（無 observer）：成功後 invalidate 會把它們標成 isInvalidated——拿掉 onSuccess 的 invalidate 就紅。
  queryClient.setQueryData(ADMIN_AUTH_PROVIDERS_QUERY_KEY, [provider]);
  queryClient.setQueryData(AUTH_CONFIG_QUERY_KEY, { providers: [], registration: { enabled: true }, passwordLogin: { enabled: true } });
  render(
    <QueryClientProvider client={queryClient}>{live ? <LiveDialog fallback={provider} /> : <ProviderIconDialog provider={provider} />}</QueryClientProvider>,
  );
  return { calls, queryClient, createObjectURL, revokeObjectURL };
}

async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Icon" }));
  return screen.findByRole("dialog", { name: "Sign-in service icon" });
}
const radio = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name });
const previewOf = (dialog: HTMLElement, name: string) => radio(dialog, name).closest("label")!.querySelector("[data-provider-icon]");
function chooseFile(dialog: HTMLElement, file: File): void {
  fireEvent.click(radio(dialog, "Upload an image"));
  fireEvent.change(dialog.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
}
const pngFile = (bytes = 64) => new File([new Uint8Array(bytes)], "logo.png", { type: "image/png" });
const mutations = (calls: Call[]) => calls.filter(c => c.method !== "GET");

describe("ProviderIconDialog（spec §6.3、§8.2 W2）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    // 先卸載（effect cleanup 會呼叫 URL.revokeObjectURL）再還原替身；順序反了，結束時 picked 非 null 的案會在卸載時 TypeError。
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("五個選項各有預覽；初始選中＝目前的 iconKind；「依範本」預覽是換算結果（不是目前的 icon）", async () => {
    // google 範本、目前選 GitLab logo：依範本的預覽必須是 Google（拿 provider.icon 當預覽就會錯成 GitLab）。
    setup({ ...BASE, template: "google", iconKind: "gitlab", icon: { type: "builtin", name: "gitlab" } });
    const dialog = await openDialog();
    expect(radio(dialog, "GitLab logo")).toBeChecked();
    expect(previewOf(dialog, "Template default")).toHaveAttribute("data-provider-icon", "google");
    expect(previewOf(dialog, "GitLab logo")).toHaveAttribute("data-provider-icon", "gitlab");
    expect(previewOf(dialog, "Google logo")).toHaveAttribute("data-provider-icon", "google");
    expect(previewOf(dialog, "Upload an image")).toBeNull();
    expect(previewOf(dialog, "None")).toBeNull();
  });

  it("目前是 upload：選中「Upload an image」、預覽是 DTO 的上傳圖網址", async () => {
    setup(UPLOADED);
    const dialog = await openDialog();
    expect(radio(dialog, "Upload an image")).toBeChecked();
    expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", UPLOADED_URL);
  });

  it("點外面不關（clickOutside）；Esc 關", async () => {
    setup(BASE);
    const dialog = await openDialog();
    await clickOutside();
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("儲存其他選項 → PATCH {iconKind}、關閉、invalidate admin-auth 與 auth-config", async () => {
    const { calls, queryClient } = setup(BASE);
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "None"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mutations(calls)).toEqual([{ method: "PATCH", url: `/api/admin/auth/providers/${ID}`, body: JSON.stringify({ iconKind: "none" }) }]);
    expect(queryClient.getQueryState(ADMIN_AUTH_PROVIDERS_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(AUTH_CONFIG_QUERY_KEY)?.isInvalidated).toBe(true);
  });

  it("選上傳＋選檔 → 真的經縮圖（512×256 畫成 128×64）、預覽換成 blob:；儲存 → PUT FormData（file＝icon.png、image/png）、關閉、invalidate", async () => {
    const { createImageBitmap, drawImage } = stubDecoder({ width: 512, height: 256 });
    const { calls, queryClient } = setup(BASE);
    const dialog = await openDialog();
    chooseFile(dialog, pngFile());
    // 等待點：預覽換成 blob: 只在縮圖完成後發生。
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 128, 64);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const [put] = mutations(calls);
    expect(put).toMatchObject({ method: "PUT", url: `/api/admin/auth/providers/${ID}/icon` });
    expect(put!.body).toBeInstanceOf(FormData);
    const file = (put!.body as FormData).get("file") as File;
    expect(file.name).toBe("icon.png");
    expect(file.type).toBe("image/png");
    // 送出的是縮圖結果（替身 toBlob 回 8 位元組），不是 64 位元組的原檔（D7）。
    expect(file.size).toBe(PNG_MAGIC.length);
    expect(mutations(calls)).toHaveLength(1);
    expect(queryClient.getQueryState(ADMIN_AUTH_PROVIDERS_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(AUTH_CONFIG_QUERY_KEY)?.isInvalidated).toBe(true);
  });

  it("失敗 → 對話框內 role=alert 顯示 errors.<code>、保持開著、可再按", async () => {
    setup(BASE, () => fakeResponse(400, { error: { code: "invalid_body", message: "請求格式錯誤" } }));
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "Google logo"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(i18n.t("errors.invalid_body"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("上傳失敗（PUT 413／415）→ 對話框內 role=alert 顯示 errors.<code>、保持開著、不 invalidate", async () => {
    for (const [status, code] of [
      [413, "file_too_large"],
      [415, "unsupported_media_type"],
    ] as const) {
      stubDecoder({ width: 64, height: 64 });
      const { calls, queryClient } = setup(BASE, call =>
        call.method === "PUT" ? fakeResponse(status, { error: { code, message: "x" } }) : fakeResponse(200, BASE),
      );
      const dialog = await openDialog();
      chooseFile(dialog, pngFile());
      await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      // 等待點：alert 只在 PUT 回來、catch 跑完後出現。
      expect(await within(dialog).findByRole("alert"), code).toHaveTextContent(i18n.t(`errors.${code}`));
      expect(screen.getByRole("dialog"), code).toBe(dialog);
      expect(mutations(calls), code).toMatchObject([{ method: "PUT", url: `/api/admin/auth/providers/${ID}/icon` }]);
      expect(queryClient.getQueryState(ADMIN_AUTH_PROVIDERS_QUERY_KEY)?.isInvalidated, code).toBe(false);
      expect(queryClient.getQueryState(AUTH_CONFIG_QUERY_KEY)?.isInvalidated, code).toBe(false);
      cleanupDialog();
    }
  });

  it("送出中：儲存鈕 disabled、文字 Saving…", async () => {
    setup(BASE, () => new Promise<Response>(() => {}));
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "None"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    const saving = await within(dialog).findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
  });

  it("關閉時 revokeObjectURL 釋放縮圖的 blob:", async () => {
    stubDecoder({ width: 64, height: 64 });
    const { revokeObjectURL } = setup(BASE);
    const dialog = await openDialog();
    chooseFile(dialog, pngFile());
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:icon-1"));
  });

  it("選 GIF／SVG → 「只接受 PNG、JPEG、WebP」、不解碼、儲存 disabled、不送請求", async () => {
    for (const type of ["image/gif", "image/svg+xml"]) {
      const { createImageBitmap } = stubDecoder({ width: 10, height: 10 });
      const { calls } = setup(BASE);
      const dialog = await openDialog();
      chooseFile(dialog, new File([new Uint8Array(8)], "x", { type }));
      expect(await within(dialog).findByRole("alert"), type).toHaveTextContent("Only PNG, JPEG and WebP images are accepted.");
      expect(createImageBitmap, type).not.toHaveBeenCalled();
      expect(within(dialog).getByRole("button", { name: "Save" }), type).toBeDisabled();
      expect(mutations(calls), type).toEqual([]);
      cleanupDialog();
    }
  });

  it("> 5 MB → 「圖片不得超過 5 MB」、不解碼、不送請求", async () => {
    const { createImageBitmap } = stubDecoder({ width: 10, height: 10 });
    const { calls } = setup(BASE);
    const dialog = await openDialog();
    chooseFile(dialog, new File([new Uint8Array(MAX_PROVIDER_ICON_SOURCE_BYTES + 1)], "big.png", { type: "image/png" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The image must be 5 MB or smaller.");
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mutations(calls)).toEqual([]);
  });

  it("解碼失敗 → 「無法讀取這張圖片」、不送請求；先選好一張再選壞的 → 前一張的預覽被清掉、儲存 disabled", async () => {
    stubDecoder({ width: 64, height: 64 });
    const { calls } = setup(BASE);
    const dialog = await openDialog();
    chooseFile(dialog, pngFile());
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    stubDecoder("fail");
    fireEvent.change(dialog.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [pngFile(32)] } });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This image can't be read.");
    expect(previewOf(dialog, "Upload an image")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mutations(calls)).toEqual([]);
  });

  it("無變更按儲存 → 關閉、不送請求（Q6）；目前是 upload 且未選新檔 → 儲存可按、關閉、不送請求", async () => {
    for (const provider of [BASE, UPLOADED]) {
      const { calls } = setup(provider);
      const dialog = await openDialog();
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      // 等待點：對話框關閉＝handleSave 已跑完。
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(mutations(calls), provider.iconKind).toEqual([]);
      cleanupDialog();
    }
  });

  it("選上傳、目前不是 upload、尚未選檔 → 儲存 disabled（Q6）", async () => {
    setup(BASE);
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "Upload an image"));
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Choose image…" })).toBeEnabled();
  });

  it("RF5 競態：選檔後縮圖未完成就取消 → 再打開 → 縮圖才完成：舊結果丟棄（無預覽、未建 blob:）、上傳選項未選檔時儲存 disabled、不送 PUT", async () => {
    const { drawImage } = stubDecoder({ width: 64, height: 64 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    // 解碼卡在 gate 上：縮圖在取消時仍 pending。
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        await gate;
        return { width: 64, height: 64, close: vi.fn() } as unknown as ImageBitmap;
      }),
    );
    const { calls, createObjectURL } = setup(BASE);
    let dialog = await openDialog();
    chooseFile(dialog, pngFile());
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    dialog = await openDialog();
    release();
    // 等待點：drawImage 被呼叫＝舊的縮圖確實跑完解碼；再讓 toBlob 之後的 await 與 React 更新走完。
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));
    await settle();
    expect(createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(radio(dialog, "Upload an image"));
    expect(previewOf(dialog, "Upload an image")).toBeNull();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Choose image…" })).toBeEnabled();
    expect(mutations(calls)).toEqual([]);
  });

  it("RF5：選上傳並選好檔、或碰到錯誤 → 取消 → 再打開：選中回到目前的 iconKind、沒有舊預覽、沒有舊錯誤；按儲存不送請求", async () => {
    stubDecoder({ width: 64, height: 64 });
    const { calls } = setup(BASE);
    let dialog = await openDialog();
    chooseFile(dialog, pngFile());
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    chooseFile(dialog, new File([new Uint8Array(8)], "x.gif", { type: "image/gif" }));
    await within(dialog).findByRole("alert");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    dialog = await openDialog();
    expect(radio(dialog, "Template default")).toBeChecked();
    expect(previewOf(dialog, "Upload an image")).toBeNull();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mutations(calls)).toEqual([]);
  });
  it("上傳儲存中：Cancel 停用、Esc 與右上 X 都關不掉；PUT 回來後等列表重抓完才關；重開選中 Upload，直接按 Save 不送請求（I1）", async () => {
    stubDecoder({ width: 64, height: 64 });
    let releasePut!: () => void;
    const putGate = new Promise<void>(resolve => {
      releasePut = resolve;
    });
    let releaseGet!: () => void;
    const getGate = new Promise<void>(resolve => {
      releaseGet = resolve;
    });
    let putDone = false;
    // provider 由 useQuery 供應（接線同卡片）：PUT 成功後的 invalidate 重抓到 upload 版，而且這次 GET 被 getGate 延遲。
    const { calls } = setup(
      BASE,
      async call => {
        if (call.method === "PUT") {
          await putGate;
          putDone = true;
          return fakeResponse(200, UPLOADED);
        }
        if (putDone) await getGate;
        return fakeResponse(200, putDone ? [UPLOADED] : [BASE]);
      },
      true,
    );
    const dialog = await openDialog();
    chooseFile(dialog, pngFile());
    await waitFor(() => expect(previewOf(dialog, "Upload an image")).toHaveAttribute("src", "blob:icon-1"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutations(calls)).toHaveLength(1));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);

    releasePut();
    // PUT 已回來、重抓（GET）還卡著：仍開著、仍是 Saving…（busy 涵蓋到重抓完成）。
    await waitFor(() => expect(calls.filter(c => c.method === "GET" && putDone).length).toBeGreaterThan(0));
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);

    releaseGet();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // 重開：列表已是 upload 版，選中的是 Upload；什麼都不動按 Save → 不送任何請求、關閉（守住 I1：不會送 PATCH 清掉剛上傳的圖）。
    const reopened = await openDialog();
    expect(radio(reopened, "Upload an image")).toBeChecked();
    const afterOpen = calls.length;
    fireEvent.click(within(reopened).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.length).toBe(afterOpen);
    expect(mutations(calls).map(c => c.method)).toEqual(["PUT"]);
  });

  it("PATCH 儲存中：Cancel 停用、Esc 與右上 X 都關不掉；PATCH 回來後才關", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { calls } = setup(BASE, async call => {
      if (call.method === "PATCH") await gate;
      return fakeResponse(200, BASE);
    });
    const dialog = await openDialog();
    fireEvent.click(radio(dialog, "None"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutations(calls)).toHaveLength(1));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await settle();
    expect(screen.getByRole("dialog")).toBe(dialog);
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

/** 迴圈案每輪重新 render 前卸載上一輪（testing-library 的自動 cleanup 只在 afterEach 跑）。 */
function cleanupDialog(): void {
  cleanup();
  vi.restoreAllMocks();
}
