import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import {
  UPDATE_CHECK_INTERVAL_MS,
  currentEntryScript,
  entryScriptFromHtml,
  installUpdateCheck,
  showUpdateAvailableToast,
} from "./update-check";

const CURRENT = "/assets/index-AAAA1111.js";
const NEWER = "/assets/index-BBBB2222.js";

function indexHtml(entry: string): string {
  return `<!doctype html><html><head>
    <link rel="manifest" href="/manifest.webmanifest" />
    <script type="module" crossorigin src="${entry}"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-CCCC.js">
    <link rel="stylesheet" crossorigin href="/assets/index-DDDD.css">
  </head><body><div id="root"></div></body></html>`;
}

/** 一份假的 document：只需要 script 查詢、visibilityState 與事件。 */
function fakeDocument(entry: string | null) {
  const target = new EventTarget();
  const doc = document.implementation.createHTMLDocument("t");
  if (entry !== null) {
    const script = doc.createElement("script");
    script.type = "module";
    script.setAttribute("src", entry);
    doc.head.append(script);
  }
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(doc, "visibilityState", { get: () => visibility });
  doc.addEventListener = target.addEventListener.bind(target) as Document["addEventListener"];
  doc.removeEventListener = target.removeEventListener.bind(target) as Document["removeEventListener"];
  return {
    doc,
    show() {
      visibility = "visible";
      target.dispatchEvent(new Event("visibilitychange"));
    },
    hide() {
      visibility = "hidden";
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

/** 讓 fetchHtml 的 promise 鏈跑完。 */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("entryScriptFromHtml／currentEntryScript", () => {
  it("從 vite build 的 index.html 抓出入口 script，不會抓到 modulepreload 或 CSS", () => {
    expect(entryScriptFromHtml(indexHtml(NEWER))).toBe(NEWER);
  });

  it("HTML 裡沒有 /assets/index-*.js（錯誤頁、dev server）→ null", () => {
    expect(entryScriptFromHtml("<html><body>502 Bad Gateway</body></html>")).toBeNull();
    expect(entryScriptFromHtml('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
  });

  it("目前頁面：讀 src 屬性原文", () => {
    expect(currentEntryScript(fakeDocument(CURRENT).doc)).toBe(CURRENT);
    expect(currentEntryScript(fakeDocument("/src/main.tsx").doc)).toBeNull();
    expect(currentEntryScript(fakeDocument(null).doc)).toBeNull();
  });
});

describe("installUpdateCheck", () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  function setup(html: string | (() => Promise<string>), entry: string | null = CURRENT) {
    const page = fakeDocument(entry);
    const fetchHtml = vi.fn(typeof html === "string" ? () => Promise.resolve(html) : html);
    const onUpdate = vi.fn();
    const uninstall = installUpdateCheck({ onUpdate, fetchHtml, now, doc: page.doc });
    return { page, fetchHtml, onUpdate, uninstall };
  }

  it("間隔是 30 分鐘", () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(30 * 60 * 1000);
  });

  it("載入後未滿 30 分鐘回到前景：不抓", async () => {
    const { page, fetchHtml } = setup(indexHtml(NEWER));
    clock += UPDATE_CHECK_INTERVAL_MS - 1;
    page.show();
    await flush();
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("滿 30 分鐘回到前景、入口 script 不同：提示一次", async () => {
    const { page, fetchHtml, onUpdate } = setup(indexHtml(NEWER));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("入口 script 相同：不提示，且下一次也要再等 30 分鐘", async () => {
    const { page, fetchHtml, onUpdate } = setup(indexHtml(CURRENT));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();

    clock += UPDATE_CHECK_INTERVAL_MS - 1;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);

    clock += 1;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });

  it("切到背景（hidden）不抓", async () => {
    const { page, fetchHtml } = setup(indexHtml(NEWER));
    clock += UPDATE_CHECK_INTERVAL_MS * 2;
    page.hide();
    await flush();
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("提示過之後不再檢查，也不再提示", async () => {
    const { page, fetchHtml, onUpdate } = setup(indexHtml(NEWER));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    clock += UPDATE_CHECK_INTERVAL_MS * 3;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("上一次還沒抓完又回到前景：不重複抓", async () => {
    let resolve!: (html: string) => void;
    const { page, fetchHtml, onUpdate } = setup(() => new Promise<string>((r) => (resolve = r)));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    resolve(indexHtml(NEWER));
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("抓失敗或回來的不是 app 的 HTML：不提示，30 分鐘後再試", async () => {
    let attempt = 0;
    const { page, fetchHtml, onUpdate } = setup(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("offline"));
      if (attempt === 2) return Promise.resolve("<html>502 Bad Gateway</html>");
      return Promise.resolve(indexHtml(NEWER));
    });
    for (let i = 0; i < 3; i++) {
      clock += UPDATE_CHECK_INTERVAL_MS;
      page.show();
      await flush();
    }
    expect(fetchHtml).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("抓失敗之後也要等滿 30 分鐘才再試", async () => {
    const { page, fetchHtml } = setup(() => Promise.reject(new Error("offline")));
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);

    clock += UPDATE_CHECK_INTERVAL_MS - 1;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(1);

    clock += 1;
    page.show();
    await flush();
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });

  it("目前頁面沒有 hash 檔名的入口 script（dev server）：完全不檢查", async () => {
    const { page, fetchHtml } = setup(indexHtml(NEWER), "/src/main.tsx");
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("拆掉監聽之後不再檢查", async () => {
    const { page, fetchHtml, uninstall } = setup(indexHtml(NEWER));
    uninstall();
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    expect(fetchHtml).not.toHaveBeenCalled();
  });
});

describe("預設的抓取", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("抓 / 時帶 Accept: text/html 與 no-store（伺服器只對接受 HTML 的請求回 index.html）", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(indexHtml(NEWER), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const page = fakeDocument(CURRENT);
    const onUpdate = vi.fn();
    let clock = 1_000_000;
    installUpdateCheck({ onUpdate, now: () => clock, doc: page.doc });
    clock += UPDATE_CHECK_INTERVAL_MS;
    page.show();
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/");
    expect((init.headers as Record<string, string>).Accept).toContain("text/html");
    expect(init.cache).toBe("no-store");
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("showUpdateAvailableToast", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    act(() => dismissAllToasts());
  });

  it("顯示「已更新」與「Reload」鈕；按了才重新載入", () => {
    render(<Toaster />);
    const reload = vi.fn();
    act(() => showUpdateAvailableToast(reload));
    expect(screen.getByText("Knotebook has been updated")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    act(() => screen.getByRole("button", { name: "Reload" }).click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("不會自己消失", () => {
    vi.useFakeTimers();
    try {
      render(<Toaster />);
      act(() => showUpdateAvailableToast(() => {}));
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("Knotebook has been updated")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("中文介面", async () => {
    await i18n.changeLanguage("zh-TW");
    render(<Toaster />);
    act(() => showUpdateAvailableToast(() => {}));
    expect(screen.getByText("Knotebook 已更新")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新整理" })).toBeInTheDocument();
  });
});
