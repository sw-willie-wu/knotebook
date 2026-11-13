import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { formatBytes, type AvatarCandidateDto, type AvatarCropUpload } from "@knotebook/shared";
import i18n from "@/i18n";
import { AVATARS_QUERY_KEY } from "@/api/avatars";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import * as encode from "@/avatars/encode";
import { configureFiller, enqueueFill, resetFiller } from "@/avatars/display-filler";
import { settle } from "@/test/outside-click";
import { AvatarCropDialog } from "./AvatarCropDialog";

// jsdom 沒有 canvas 與 createImageBitmap：編碼模組換成替身（真實編碼靠 e2e）。
vi.mock("@/avatars/encode", () => ({
  decodeImage: vi.fn(),
  renderDisplay: vi.fn(),
}));

const MAX_UPLOAD = 10 * 1024 * 1024;
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function candidate(over: Partial<AvatarCandidateDto> = {}): AvatarCandidateDto {
  return {
    id: ID,
    source: "upload",
    providerName: null,
    avatar: { id: ID, v: 3 },
    pending: false,
    current: false,
    crop: { x: 100, y: 0, size: 200 },
    originalWidth: 600,
    originalHeight: 400,
    originalSize: 1000,
    displaySize: 500,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

// 取原圖的回應用位元組當 body，不用 `new Blob(...)`：測試裡的全域 Blob 是 jsdom 的，Node 內建的 Response
// 不認得它——Node 22 會在建構時丟「object.stream is not a function」，Node 24 會把它轉成字串 "[object Blob]"，
// 兩種都不會把原圖位元組放進回應。
const ORIGINAL_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];
function originalResponse(): Response {
  return new Response(new Uint8Array(ORIGINAL_BYTES), { headers: { "content-type": "image/png" } });
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const closeBitmap = vi.fn();

// jsdom 沒有 PointerEvent；補一個帶 pointerId 的 MouseEvent，讓 clientX／clientY 與 pointerId 進得去。
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

function setup(
  source: Parameters<typeof AvatarCropDialog>[0]["source"],
  respond: (call: Call) => Response | Promise<Response> = () => json(200, candidate()),
  opts: { maxUploadBytes?: number } = { maxUploadBytes: MAX_UPLOAD },
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body };
      if (call.url === "/api/auth/config") return json(200, { providers: [], maxUploadBytes: opts.maxUploadBytes });
      calls.push(call);
      return respond(call);
    }),
  );
  let n = 0;
  const createObjectURL = vi.fn(() => `blob:crop-${++n}`);
  const revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(AVATARS_QUERY_KEY, { candidates: [], auto: false, refreshable: [] });
  queryClient.setQueryData(AUTH_CONFIG_QUERY_KEY, { providers: [], maxUploadBytes: opts.maxUploadBytes });
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  const tree = (open: boolean, current = source) => (
    <QueryClientProvider client={queryClient}>
      <AvatarCropDialog open={open} source={current} onOpenChange={onOpenChange} onSaved={onSaved} />
      <Toaster />
    </QueryClientProvider>
  );
  const view = render(tree(true));
  return { calls, queryClient, onOpenChange, onSaved, createObjectURL, revokeObjectURL, view, tree };
}

const newFile = () => ({ kind: "new", file: new File([new Uint8Array(8)], "alice.png", { type: "image/png" }) }) as const;

/** 圖載入完成：jsdom 不會載 blob:，手動給尺寸再觸發 load。 */
async function loadImage(dialog: HTMLElement, width = 600, height = 400): Promise<HTMLImageElement> {
  const img = await waitFor(() => {
    const el = dialog.querySelector("img");
    expect(el).not.toBeNull();
    return el as HTMLImageElement;
  });
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(img);
  return img;
}

async function openLoaded(source: Parameters<typeof setup>[0] = newFile(), respond?: Parameters<typeof setup>[1], opts?: Parameters<typeof setup>[2]) {
  const ctx = setup(source, respond, opts);
  const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
  const img = await loadImage(dialog);
  return { ...ctx, dialog, img };
}

const px = (value: string) => Number.parseFloat(value);
const left = (img: HTMLElement) => px(img.style.left);
const top = (img: HTMLElement) => px(img.style.top);
const width = (img: HTMLElement) => px(img.style.width);
const cropArea = (dialog: HTMLElement) => within(dialog).getByRole("application");
const slider = (dialog: HTMLElement) => within(dialog).getByRole("slider", { name: "Zoom" }) as HTMLInputElement;
const saveButton = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: /^(Save|Uploading…)$/ });
const mutations = (calls: Call[]) => calls.filter(c => c.method !== "GET");

describe("AvatarCropDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("PointerEvent", FakePointerEvent);
    vi.mocked(encode.decodeImage).mockResolvedValue({ width: 600, height: 400, close: closeBitmap } as unknown as ImageBitmap);
    vi.mocked(encode.renderDisplay).mockResolvedValue(new Blob([new Uint8Array(4)], { type: "image/webp" }));
  });
  afterEach(() => {
    cleanup();
    dismissAllToasts();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  describe("開框與可及名稱", () => {
    it("對話框有名稱與說明；裁切區域是 application、roledescription＝裁切區域；滑桿名稱「Zoom」", async () => {
      const { dialog } = await openLoaded();
      expect(dialog).toHaveAccessibleDescription("Drag to move. Use the slider or scroll to zoom.");
      const area = cropArea(dialog);
      expect(area).toHaveAttribute("aria-roledescription", "Crop area");
      expect(area).toHaveAttribute("tabindex", "0");
      expect(slider(dialog)).toBeInTheDocument();
    });

    it("開框後焦點落在裁切區域（鍵盤使用者不必先 Tab）", async () => {
      const { dialog } = await openLoaded();
      await settle();
      expect(cropArea(dialog)).toHaveFocus();
    });

    it("zh-TW 的名稱與說明", async () => {
      await i18n.changeLanguage("zh-TW");
      setup(newFile());
      const dialog = await screen.findByRole("dialog", { name: "調整頭貼" });
      expect(within(dialog).getByRole("application")).toHaveAttribute("aria-roledescription", "裁切區域");
      expect(within(dialog).getByRole("slider", { name: "縮放" })).toBeInTheDocument();
    });

    it("圖載入前「儲存」停用；載入後可按", async () => {
      setup(newFile());
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      expect(saveButton(dialog)).toBeDisabled();
      expect(slider(dialog)).toBeDisabled();
      await loadImage(dialog);
      expect(saveButton(dialog)).toBeEnabled();
    });

    it("初值：新檔置中、最小縮放（600×400 在 280 視窗：scale 0.7）", async () => {
      const { img } = await openLoaded();
      expect(width(img)).toBeCloseTo(420);
      expect(left(img)).toBeCloseTo(-70);
      expect(top(img)).toBeCloseTo(0);
    });

    it("初值：既有候選用它的裁切（size 200 → scale 1.4，x 100 → left -140）", async () => {
      const { img } = await openLoaded({ kind: "existing", candidate: candidate() }, ({ url }) =>
        url.endsWith("/original") ? originalResponse() : json(200, candidate()),
      );
      expect(width(img)).toBeCloseTo(840);
      expect(left(img)).toBeCloseTo(-140);
      expect(top(img)).toBeCloseTo(0);
    });
  });

  describe("鍵盤", () => {
    async function zoomedIn() {
      const ctx = await openLoaded();
      // 先放大讓兩軸都有活動空間：縮放 1.4 → 圖 840×560
      fireEvent.change(slider(ctx.dialog), { target: { value: "1.4" } });
      return ctx;
    }

    it("方向鍵移動 10 px、Shift 移動 50 px（圖跟著方向鍵走）", async () => {
      const { dialog, img } = await zoomedIn();
      const area = cropArea(dialog);
      const x0 = left(img);
      const y0 = top(img);
      fireEvent.keyDown(area, { key: "ArrowLeft" });
      expect(left(img)).toBeCloseTo(x0 - 10);
      fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true });
      expect(left(img)).toBeCloseTo(x0 - 10 + 50);
      fireEvent.keyDown(area, { key: "ArrowUp" });
      expect(top(img)).toBeCloseTo(y0 - 10);
      fireEvent.keyDown(area, { key: "ArrowDown", shiftKey: true });
      expect(top(img)).toBeCloseTo(y0 - 10 + 50);
    });

    it("移動被夾住：圖不會離開視窗（左上角 ≤ 0、右下角 ≥ 視窗）", async () => {
      const { dialog, img } = await zoomedIn();
      const area = cropArea(dialog);
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true });
      expect(left(img)).toBe(0);
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
      expect(left(img)).toBeCloseTo(280 - 840);
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "ArrowUp", shiftKey: true });
      expect(top(img)).toBeCloseTo(280 - 560);
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "ArrowDown", shiftKey: true });
      expect(top(img)).toBe(0);
    });

    it("+／- 改縮放一級，且夾在上下限（600×400：0.7～4）", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      const w0 = width(img);
      fireEvent.keyDown(area, { key: "+" });
      expect(width(img)).toBeGreaterThan(w0);
      fireEvent.keyDown(area, { key: "-" });
      expect(width(img)).toBeCloseTo(w0);
      for (let i = 0; i < 5; i++) fireEvent.keyDown(area, { key: "-" });
      expect(width(img)).toBeCloseTo(420); // 最小縮放：短邊剛好填滿
      for (let i = 0; i < 40; i++) fireEvent.keyDown(area, { key: "+" });
      expect(width(img)).toBeCloseTo(2400); // 4 × 600
      expect(Number(slider(dialog).value)).toBeCloseTo(4);
    });

    it("帶 Ctrl／⌘／Alt 的 =、-、方向鍵不攔截（瀏覽器的頁面縮放照常），不帶修飾鍵的 = 才攔", async () => {
      const { dialog, img } = await zoomedIn();
      const area = cropArea(dialog);
      const w0 = width(img);
      const x0 = left(img);
      for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
        expect(fireEvent.keyDown(area, { key: "=", ...mod })).toBe(true);
        expect(fireEvent.keyDown(area, { key: "-", ...mod })).toBe(true);
        expect(fireEvent.keyDown(area, { key: "0", ...mod })).toBe(true);
        expect(fireEvent.keyDown(area, { key: "ArrowLeft", ...mod })).toBe(true);
      }
      expect(width(img)).toBeCloseTo(w0);
      expect(left(img)).toBeCloseTo(x0);
      expect(fireEvent.keyDown(area, { key: "=" })).toBe(false);
      expect(width(img)).toBeGreaterThan(w0);
    });

    it("焦點在滑桿時方向鍵不移動圖（事件只由裁切區域處理）", async () => {
      const { dialog, img } = await zoomedIn();
      const x0 = left(img);
      fireEvent.keyDown(slider(dialog), { key: "ArrowLeft" });
      expect(left(img)).toBeCloseTo(x0);
    });
  });

  describe("滑桿、滾輪、拖曳", () => {
    it("滑桿改縮放", async () => {
      const { dialog, img } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      expect(width(img)).toBeCloseTo(840);
    });

    it("滑桿範圍＝縮放上下限", async () => {
      const { dialog } = await openLoaded();
      expect(Number(slider(dialog).min)).toBeCloseTo(0.7);
      expect(Number(slider(dialog).max)).toBeCloseTo(4);
    });

    it("滾輪向上放大、向下縮小", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      const w0 = width(img);
      fireEvent.wheel(area, { deltaY: -100 });
      const w1 = width(img);
      expect(w1).toBeGreaterThan(w0);
      fireEvent.wheel(area, { deltaY: 100 });
      expect(width(img)).toBeCloseTo(w0);
    });

    it("滾輪事件被 preventDefault（不捲動背後的頁面）", async () => {
      const { dialog } = await openLoaded();
      const event = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
      cropArea(dialog).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("單指拖曳平移（圖跟著手走），放開後不再動", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      const x0 = left(img);
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 90, clientY: 100 });
      expect(left(img)).toBeCloseTo(x0 - 10);
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 60, clientY: 100 });
      expect(left(img)).toBeCloseTo(x0 - 40);
      fireEvent.pointerUp(area, { pointerId: 1, clientX: 60, clientY: 100 });
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 20, clientY: 100 });
      expect(left(img)).toBeCloseTo(x0 - 40);
    });

    it("拖曳被夾住", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 1000, clientY: 1000 });
      expect(left(img)).toBe(0);
      expect(top(img)).toBe(0);
    });

    it("雙指捏合放大", async () => {
      const { dialog, img } = await openLoaded();
      const area = cropArea(dialog);
      const w0 = width(img);
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 140 });
      fireEvent.pointerDown(area, { pointerId: 2, clientX: 180, clientY: 140 });
      fireEvent.pointerMove(area, { pointerId: 2, clientX: 260, clientY: 140 });
      expect(width(img)).toBeGreaterThan(w0);
    });
  });

  describe("儲存", () => {
    it("新檔：POST /api/auth/avatars，original、display、crop（整數）都在", async () => {
      const { dialog, calls, onSaved, onOpenChange } = await openLoaded();
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      const [call] = mutations(calls);
      expect(call).toMatchObject({ method: "POST", url: "/api/auth/avatars" });
      const form = call!.body as FormData;
      expect((form.get("original") as File).name).toBe("alice.png");
      expect((form.get("display") as File).name).toBe("display.webp");
      const crop = JSON.parse(form.get("crop") as string) as Record<string, number>;
      expect(crop).toEqual({ x: 100, y: 0, size: 400, width: 600, height: 400 } satisfies AvatarCropUpload);
      for (const v of Object.values(crop)) expect(Number.isInteger(v)).toBe(true);
      expect(vi.mocked(encode.renderDisplay)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(encode.renderDisplay).mock.calls[0]![1]).toEqual({ x: 100, y: 0, size: 400 });
      expect(closeBitmap).toHaveBeenCalledTimes(1);
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: ID }));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("縮放與拖曳後的 crop 跟著變（整數、落在圖內）", async () => {
      const { dialog, calls, onSaved } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: "1.4" } }); // size 200
      fireEvent.keyDown(cropArea(dialog), { key: "ArrowRight", shiftKey: true });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const crop = JSON.parse((mutations(calls)[0]!.body as FormData).get("crop") as string) as { x: number; y: number; size: number };
      expect(crop.size).toBe(200);
      expect(crop.x + crop.size).toBeLessThanOrEqual(600);
      expect(crop.y + crop.size).toBeLessThanOrEqual(400);
      for (const v of Object.values(crop)) expect(Number.isInteger(v)).toBe(true);
    });

    it("調整既有候選：先取原圖，PUT /api/auth/avatars/:id/display 帶 version、不帶 original", async () => {
      const { dialog, calls, onSaved } = await openLoaded({ kind: "existing", candidate: candidate() }, ({ url }) =>
        url.endsWith("/original") ? originalResponse() : json(200, candidate()),
      );
      expect(calls[0]).toMatchObject({ method: "GET", url: `/api/auth/avatars/${ID}/original` });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const [call] = mutations(calls);
      expect(call).toMatchObject({ method: "PUT", url: `/api/auth/avatars/${ID}/display` });
      const form = call!.body as FormData;
      expect(form.get("version")).toBe("3");
      expect(form.get("original")).toBeNull();
      expect(JSON.parse(form.get("crop") as string)).toEqual({ x: 100, y: 0, size: 200, width: 600, height: 400 } satisfies AvatarCropUpload);
      // 解碼拿到的是取回的原圖本身（位元組與型別），不是別的東西。
      const decoded = vi.mocked(encode.decodeImage).mock.calls[0]![0];
      expect(decoded.type).toBe("image/png");
      expect(Array.from(new Uint8Array(await decoded.arrayBuffer()))).toEqual(ORIGINAL_BYTES);
    });

    it("調整既有候選：送出的 version 是取原圖當下的，之後 props 換成新版也不變（伺服器回 avatar_outdated 時照既有流程關框）", async () => {
      const respond = ({ url, method }: Call) => {
        if (url.endsWith("/original")) return originalResponse();
        return method === "PUT" ? json(409, { error: { code: "avatar_outdated", message: "x" } }) : json(200, candidate());
      };
      const ctx = await openLoaded({ kind: "existing", candidate: candidate() }, respond);
      ctx.view.rerender(ctx.tree(true, { kind: "existing", candidate: candidate({ avatar: { id: ID, v: 4 } }) }));
      fireEvent.click(saveButton(ctx.dialog));
      await waitFor(() => expect(ctx.onOpenChange).toHaveBeenCalledWith(false));
      const [call] = mutations(ctx.calls);
      expect((call!.body as FormData).get("version")).toBe("3");
    });

    it("上傳中：鈕停用、顯示「Uploading…」、Esc 與取消都關不掉；完成後關框", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const { dialog, onOpenChange, calls } = await openLoaded(newFile(), () => pending);
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      const busy = within(dialog).getByRole("button", { name: "Uploading…" });
      expect(busy).toBeDisabled();
      expect(slider(dialog)).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
      fireEvent.keyDown(dialog, { key: "Escape" });
      await settle();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Adjust picture" })).toBeInTheDocument();
      await act(async () => {
        release(json(200, candidate()));
      });
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("上傳中點 X 也關不掉；沒在上傳時 Esc 會關", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const { dialog, onOpenChange, calls } = await openLoaded(newFile(), () => pending);
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await settle();
      expect(onOpenChange).not.toHaveBeenCalled();
      await act(async () => {
        release(json(200, candidate()));
      });
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      onOpenChange.mockClear();
      // 這次沒有上傳進行：Esc 正常關
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });
  });

  describe("上傳進行中", () => {
    it("裁切區不能移動或縮放：鍵盤、拖曳、滾輪都不動，送出的是按下儲存當下的裁切", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const { dialog, calls, img } = await openLoaded(newFile(), () => pending);
      const area = cropArea(dialog);
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      const w0 = width(img);
      const x0 = left(img);
      const y0 = top(img);
      fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
      fireEvent.keyDown(area, { key: "+" });
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 60, clientY: 80 });
      fireEvent.wheel(area, { deltaY: -200 });
      expect(left(img)).toBeCloseTo(x0);
      expect(top(img)).toBeCloseTo(y0);
      expect(width(img)).toBeCloseTo(w0);
      await act(async () => {
        release(json(200, candidate()));
      });
    });
  });

  describe("上傳進行中（拖曳已開始）", () => {
    it("先按住拖曳、再開始上傳：後續的 pointermove 不再移動裁切", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const { dialog, calls, img } = await openLoaded(newFile(), () => pending);
      const area = cropArea(dialog);
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(mutations(calls)).toHaveLength(1));
      const x0 = left(img);
      const y0 = top(img);
      fireEvent.pointerMove(area, { pointerId: 1, clientX: 60, clientY: 80 });
      expect(left(img)).toBeCloseTo(x0);
      expect(top(img)).toBeCloseTo(y0);
      await act(async () => {
        release(json(200, candidate()));
      });
    });
  });

  describe("視窗尺寸改變", () => {
    function fakeObserver() {
      const callbacks: Array<() => void> = [];
      const disconnect = vi.fn();
      class FakeResizeObserver {
        constructor(cb: () => void) {
          callbacks.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      }
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      return { callbacks, disconnect };
    }

    it("方框變大、縮放已在放大上限：裁切中心不變", async () => {
      const { callbacks } = fakeObserver();
      const { dialog, calls, onSaved } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: slider(dialog).max } });
      Object.defineProperty(cropArea(dialog), "clientWidth", { configurable: true, value: 400 });
      act(() => callbacks.forEach(cb => cb()));
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const crop = JSON.parse((mutations(calls)[0]!.body as FormData).get("crop") as string) as Record<string, number>;
      expect(crop.size).toBe(100);
      expect(Math.abs(crop.x! + crop.size! / 2 - 300)).toBeLessThanOrEqual(1);
      expect(Math.abs(crop.y! + crop.size! / 2 - 200)).toBeLessThanOrEqual(1);
    });

    it("方框量到 0 時不換算、也不丟錯", async () => {
      const { callbacks } = fakeObserver();
      const { dialog, img } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      const w0 = width(img);
      Object.defineProperty(cropArea(dialog), "clientWidth", { configurable: true, value: 0 });
      expect(() => act(() => callbacks.forEach(cb => cb()))).not.toThrow();
      expect(width(img)).toBeCloseTo(w0);
      expect(screen.getByRole("dialog", { name: "Adjust picture" })).toBeInTheDocument();
    });

    it("關閉對話框時中斷尺寸監聽", async () => {
      const { disconnect } = fakeObserver();
      const ctx = await openLoaded();
      expect(disconnect).not.toHaveBeenCalled();
      ctx.view.rerender(ctx.tree(false));
      await waitFor(() => expect(disconnect).toHaveBeenCalled());
    });

    it("方框邊長改變時，圖照比例縮放、存檔的裁切不變", async () => {
      const callbacks: Array<() => void> = [];
      class FakeResizeObserver {
        constructor(cb: () => void) {
          callbacks.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      const { dialog, img, calls, onSaved } = await openLoaded();
      fireEvent.change(slider(dialog), { target: { value: "1.4" } });
      expect(width(img)).toBeCloseTo(840);
      Object.defineProperty(cropArea(dialog), "clientWidth", { configurable: true, value: 140 });
      act(() => callbacks.forEach(cb => cb()));
      expect(width(img)).toBeCloseTo(420);
      expect(left(img)).toBeCloseTo(-140);
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const crop = JSON.parse((mutations(calls)[0]!.body as FormData).get("crop") as string) as Record<string, number>;
      expect(crop).toEqual({ x: 200, y: 100, size: 200, width: 600, height: 400 } satisfies AvatarCropUpload);
    });
  });

  describe("錯誤分流", () => {
    async function saveWith(respond: (call: Call) => Response, opts?: Parameters<typeof setup>[2]) {
      const ctx = await openLoaded(newFile(), respond, opts);
      fireEvent.click(saveButton(ctx.dialog));
      return ctx;
    }
    const failure = (status: number, code: string, extra: Record<string, unknown> = {}) => () =>
      json(status, { error: { code, message: "SERVER WORDING THAT MUST NOT BE USED" }, ...extra });

    it("413：顯示「超過 {大小} 上限」，大小是站台的上傳上限；不靠 message", async () => {
      const { dialog, onOpenChange } = await saveWith(failure(413, "anything_at_all"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(`The image is larger than the ${formatBytes(MAX_UPLOAD)} limit.`);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(saveButton(dialog)).toBeEnabled();
    });

    it("413 但站台沒給上限：退回通用上傳失敗", async () => {
      const { dialog } = await saveWith(failure(413, "anything_at_all"), { maxUploadBytes: undefined });
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Upload failed. Please try again.");
    });

    it("415：無法讀取這張圖", async () => {
      const { dialog } = await saveWith(failure(415, "unsupported_media_type"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't read this image. PNG, JPEG and WebP are supported.");
    });

    it("storage_quota_exceeded：既有的「空間已滿」文案＋用量", async () => {
      const { dialog } = await saveWith(
        failure(409, "storage_quota_exceeded", { storage: { incomingBytes: 10, usedBytes: 2048, quotaBytes: 4096 } }),
      );
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("Storage is full");
      expect(alert).toHaveTextContent(`${formatBytes(2048)} of ${formatBytes(4096)} used`);
      // 標題與說明分兩塊，不併成一句
      const parts = Array.from(alert.children).map(el => el.textContent);
      expect(parts).toEqual(["Storage is full", `${formatBytes(2048)} of ${formatBytes(4096)} used. Ask a site admin for more space.`]);
    });

    it("storage_quota_exceeded 沒有用量數字：用通用句", async () => {
      const { dialog } = await saveWith(failure(409, "storage_quota_exceeded"));
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("Storage is full");
      expect(alert).not.toHaveTextContent("of");
    });

    it("server_busy：既有的伺服器忙碌訊息", async () => {
      const { dialog } = await saveWith(failure(409, "server_busy"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("The server is busy. Please try again shortly.");
    });

    it("too_many_requests（429）：既有的請求過於頻繁訊息", async () => {
      const { dialog } = await saveWith(failure(429, "too_many_requests"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Too many requests. Please slow down.");
    });

    it("其他（500）：上傳失敗，請再試一次", async () => {
      const { dialog } = await saveWith(failure(500, "internal"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Upload failed. Please try again.");
    });

    it("網路中斷：上傳失敗，請再試一次，且鈕恢復可按", async () => {
      const ctx = await openLoaded(newFile(), () => {
        throw new TypeError("Failed to fetch");
      });
      fireEvent.click(saveButton(ctx.dialog));
      expect(await within(ctx.dialog).findByRole("alert")).toHaveTextContent("Upload failed. Please try again.");
      expect(saveButton(ctx.dialog)).toBeEnabled();
    });

    it("avatar_outdated：提示、關框、重抓候選清單", async () => {
      const { dialog, onOpenChange, queryClient } = await saveWith(failure(409, "avatar_outdated"));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(await screen.findByText("This picture was updated elsewhere. Open it again to adjust.")).toBeInTheDocument();
      expect(queryClient.getQueryState(AVATARS_QUERY_KEY)?.isInvalidated).toBe(true);
      expect(dialog).toBeDefined();
    });

    it("解碼失敗（解碼丟錯）：無法讀取這張圖，不送出", async () => {
      vi.mocked(encode.decodeImage).mockRejectedValue(new Error("cannot decode image"));
      const { dialog, calls } = await saveWith(() => json(200, candidate()));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't read this image. PNG, JPEG and WebP are supported.");
      expect(mutations(calls)).toHaveLength(0);
    });

    it("編碼失敗（畫不出或產物過大）：不送出，鈕恢復", async () => {
      vi.mocked(encode.renderDisplay).mockRejectedValue(new Error("encoded image too large"));
      const { dialog, calls } = await saveWith(() => json(200, candidate()));
      expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
      expect(mutations(calls)).toHaveLength(0);
      expect(saveButton(dialog)).toBeEnabled();
      expect(closeBitmap).toHaveBeenCalled();
    });

    it("瀏覽器讀不了這張圖（img 載入失敗，例如 HEIC）：無法讀取，儲存停用", async () => {
      setup(newFile());
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      const img = await waitFor(() => {
        const el = dialog.querySelector("img");
        expect(el).not.toBeNull();
        return el as HTMLImageElement;
      });
      fireEvent.error(img);
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't read this image. PNG, JPEG and WebP are supported.");
      expect(saveButton(dialog)).toBeDisabled();
    });

    it("既有候選的原圖已不存在（404）：照實說找不到，不說上傳失敗，儲存停用", async () => {
      setup({ kind: "existing", candidate: candidate() }, () => json(404, { error: { code: "not_found", message: "x" } }));
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("We couldn't find what you were looking for.");
      expect(alert).not.toHaveTextContent("Upload failed");
      expect(saveButton(dialog)).toBeDisabled();
    });

    it("既有候選的原圖讀取失敗（網路中斷）：說讀不了這張圖，不說上傳失敗", async () => {
      setup({ kind: "existing", candidate: candidate() }, () => {
        throw new TypeError("Failed to fetch");
      });
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't read this image.");
      expect(alert).not.toHaveTextContent("Upload failed");
      expect(saveButton(dialog)).toBeDisabled();
    });

    it("zh-TW：413 與上傳失敗用中文", async () => {
      await i18n.changeLanguage("zh-TW");
      const ctx = setup(newFile(), failure(413, "x"));
      const dialog = await screen.findByRole("dialog", { name: "調整頭貼" });
      await loadImage(dialog);
      fireEvent.click(within(dialog).getByRole("button", { name: "儲存" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(`圖片超過 ${formatBytes(MAX_UPLOAD)} 上限。`);
      expect(ctx.calls.length).toBeGreaterThan(0);
    });
  });

  describe("與背景補產互斥", () => {
    function fillerDeps() {
      const fetchOriginal = vi.fn(async () => new Blob([new Uint8Array([1])], { type: "image/png" }));
      configureFiller({ fetchOriginal, putDisplay: vi.fn(async () => ({})), invalidate: vi.fn() });
      return fetchOriginal;
    }

    it("既有候選的裁切框開著時，背景補產跳過那張；關框後才處理", async () => {
      resetFiller();
      const fetchOriginal = fillerDeps();
      const ctx = setup({ kind: "existing", candidate: candidate() });
      await screen.findByRole("dialog", { name: "Adjust picture" });
      enqueueFill({ id: ID, v: 3 });
      await settle();
      expect(fetchOriginal).not.toHaveBeenCalled();
      ctx.view.rerender(ctx.tree(false));
      await waitFor(() => expect(fetchOriginal).toHaveBeenCalledTimes(1));
      resetFiller();
    });

    it("卸載（例如換頁）也解除登記", async () => {
      resetFiller();
      const fetchOriginal = fillerDeps();
      const ctx = setup({ kind: "existing", candidate: candidate() });
      await screen.findByRole("dialog", { name: "Adjust picture" });
      enqueueFill({ id: ID, v: 3 });
      await settle();
      expect(fetchOriginal).not.toHaveBeenCalled();
      ctx.view.unmount();
      await waitFor(() => expect(fetchOriginal).toHaveBeenCalledTimes(1));
      resetFiller();
    });

    it("調整既有候選並儲存成功：這張排隊中的補產丟掉（再補只會撞版本）", async () => {
      resetFiller();
      const fetchOriginal = fillerDeps();
      const { dialog, onSaved, view, tree } = await openLoaded({ kind: "existing", candidate: candidate() });
      enqueueFill({ id: ID, v: 3 });
      fireEvent.click(saveButton(dialog));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      view.rerender(tree(false)); // 父層收到 onSaved 後關框：解除登記，佇列此時不該還有這張
      await settle();
      expect(fetchOriginal).not.toHaveBeenCalled();
      resetFiller();
    });

    it("新上傳的裁切框不登記任何候選（補產照常進行）", async () => {
      resetFiller();
      const fetchOriginal = fillerDeps();
      setup(newFile());
      await screen.findByRole("dialog", { name: "Adjust picture" });
      enqueueFill({ id: ID, v: 3 });
      await waitFor(() => expect(fetchOriginal).toHaveBeenCalledTimes(1));
      resetFiller();
    });
  });

  describe("blob 網址", () => {
    it("新檔：開框建一個 blob 網址給 <img>，關框時釋放", async () => {
      const ctx = setup(newFile());
      const dialog = await screen.findByRole("dialog", { name: "Adjust picture" });
      const img = await waitFor(() => {
        const el = dialog.querySelector("img");
        expect(el).not.toBeNull();
        return el as HTMLImageElement;
      });
      expect(img).toHaveAttribute("src", "blob:crop-1");
      expect(ctx.createObjectURL).toHaveBeenCalledTimes(1);
      expect(ctx.revokeObjectURL).not.toHaveBeenCalled();
      ctx.view.rerender(ctx.tree(false));
      await waitFor(() => expect(ctx.revokeObjectURL).toHaveBeenCalledWith("blob:crop-1"));
    });

    it("卸載時釋放", async () => {
      const ctx = setup(newFile());
      await screen.findByRole("dialog", { name: "Adjust picture" });
      await waitFor(() => expect(ctx.createObjectURL).toHaveBeenCalled());
      ctx.view.unmount();
      expect(ctx.revokeObjectURL).toHaveBeenCalledWith("blob:crop-1");
    });

    it("既有候選：原圖到手後才建 blob 網址，關框釋放；原圖還沒回來就關框則不建", async () => {
      let release: (r: Response) => void = () => {};
      const pending = new Promise<Response>(resolve => (release = resolve));
      const ctx = setup({ kind: "existing", candidate: candidate() }, () => pending);
      await screen.findByRole("dialog", { name: "Adjust picture" });
      expect(ctx.createObjectURL).not.toHaveBeenCalled();
      ctx.view.rerender(ctx.tree(false));
      await act(async () => {
        release(originalResponse());
        await settle();
      });
      expect(ctx.createObjectURL).not.toHaveBeenCalled();
    });
  });
});
