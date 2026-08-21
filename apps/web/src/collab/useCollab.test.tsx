import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ApiFail } from "@/api/client";
import {
  COLLAB_CLOSE_NOTE_DELETED,
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_INVALID_TOKEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_REJECT_SERVER_ERROR,
} from "@knotebook/shared";

// HocuspocusProvider 會開真的 WebSocket，jsdom 裡沒有對端。換成一個假的：把
// configuration 收下來，讓測試直接扮演 server 觸發 onClose/onAuthenticated，並且
// 記錄 disconnect/connect/destroy 的呼叫。
interface FakeProvider {
  configuration: Record<string, unknown> & {
    token: () => Promise<string>;
    onAuthenticated: () => void;
  };
  listeners: Map<string, ((payload: unknown) => void)[]>;
  emit: (event: string, payload: unknown) => void;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: class {
    configuration: unknown;
    listeners = new Map<string, ((payload: unknown) => void)[]>();
    disconnect = vi.fn();
    connect = vi.fn();
    destroy = vi.fn();
    awareness = {};
    constructor(configuration: unknown) {
      this.configuration = configuration;
      hoisted.instances.push(this);
    }
    on(event: string, handler: (payload: unknown) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, payload: unknown) {
      for (const handler of this.listeners.get(event) ?? []) handler(payload);
    }
  },
}));

const { useCollab } = await import("./useCollab");

const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_NOTE_ID = "22222222-2222-2222-2222-222222222222";

function provider(index = 0): FakeProvider {
  return hoisted.instances[index] as FakeProvider;
}

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const tokenOk = (role: string) =>
  fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: "jwt", role }) });

const apiFail = (status: number, code: string) =>
  fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code, message: "x" } }) });

function Probe({ onUnauthorized, noteId = NOTE_ID }: { onUnauthorized?: () => void; noteId?: string }) {
  const { state } = useCollab({ noteId, onUnauthorized: onUnauthorized ?? (() => {}) });
  return <div data-testid="phase">{state.phase === "connected" ? `connected:${state.role}` : state.phase}</div>;
}

const phase = () => screen.getByTestId("phase").textContent;

describe("useCollab", () => {
  beforeEach(() => {
    hoisted.instances.length = 0;
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("N7：provider 自建 socket——不傳 websocketProvider、不開 sessionAwareness", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    render(<Probe />);

    const config = provider().configuration;
    expect(config.name).toBe(NOTE_ID);
    expect(String(config.url)).toMatch(/^wss?:\/\/.+\/collab$/);
    // 共用 websocketProvider 會讓 disconnect() 變 no-op → 撤權流程整條失效。
    expect(config).not.toHaveProperty("websocketProvider");
    // sessionAwareness 會把 documentName 換成複合鍵，撞掉 server 的連線索引。
    expect(config.sessionAwareness).toBeUndefined();
  });

  it("close 監聽走 provider.on('close')，不放進 configuration（放進去會被註冊兩次）", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    render(<Probe />);

    // provider 自管 socket 時會把同一個 configuration 交給內部的
    // HocuspocusProviderWebsocket，configuration.onClose 因此會被掛兩次、每則
    // socket close 觸發兩次——一次性的 pending 旗標會被第二次穿透。
    expect(provider().configuration).not.toHaveProperty("onClose");
    expect(provider().listeners.get("close")).toHaveLength(1);
  });

  it("disconnect() 沒有帶出 close 事件時，逾時保險絲仍會補一次重連", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(p.connect).not.toHaveBeenCalled();

    // 沒有任何 close 事件回來（socket 早就不在）——保險絲到期後自己重連。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("reconnecting-once");
  });

  it("token function 打 collab-token endpoint，並用回應頂層的 role 驅動狀態", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);

    const config = provider().configuration;
    await act(async () => {
      await expect(config.token()).resolves.toBe("jwt");
    });

    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/notes/${NOTE_ID}/collab-token`);
    expect(init.method).toBe("POST");

    // 取到 token 還不算連上；onAuthenticated 才是 open。
    expect(phase()).toBe("connecting");
    act(() => config.onAuthenticated());
    expect(phase()).toBe("connected:editor");
  });

  it("token 401 → 走登出回呼、不重試", async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn(() => Promise.resolve(apiFail(401, "unauthorized")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe onUnauthorized={onUnauthorized} />);

    await act(async () => {
      await expect(provider().configuration.token()).rejects.toThrow();
    });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("connecting");
  });

  it("token 429 → 退避重試（不是授權失敗，不得踢人）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiFail(429, "too_many_requests"))
      .mockResolvedValueOnce(apiFail(503, "server_busy"))
      .mockResolvedValue(tokenOk("viewer"));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);

    const pending = provider().configuration.token();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await expect(pending).resolves.toBe("jwt");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(phase()).toBe("connecting");
  });

  it("撤權雙擊：close(REVOKED) → disconnect+connect → token-role 'none' → kicked", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(tokenOk("editor")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);

    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    // 第一擊：只 disconnect，**還不能** connect（socket 尚未真的關掉，
    // HocuspocusProviderWebsocket.connect() 在 status 仍是 Connected 時會空轉）。
    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    expect(p.connect).not.toHaveBeenCalled();

    // 我方 disconnect() 造成的 socket close（reason 空字串）必須被吞掉——否則觀察窗
    // 會被重置成 connecting，第二擊就永遠等不到——並且**就在這一刻**發動那次重連。
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.connect).toHaveBeenCalledTimes(1);

    // 第二擊：重連時取回的 role 就是 'none'
    fetchMock.mockResolvedValue(tokenOk("none"));
    await act(async () => {
      await p.configuration.token();
    });
    expect(phase()).toBe("kicked");
    expect(p.disconnect).toHaveBeenCalledTimes(2);
  });

  it("第二發 close(REVOKED) 同樣進 kicked（server 真的再送一次應用層 CLOSE 的路徑）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("kicked");
  });

  it("網路斷線（其他 reason）→ connecting，不呼叫 disconnect（交給 provider 內建退避）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("owner"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:owner");

    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(phase()).toBe("connecting");
    expect(p.disconnect).not.toHaveBeenCalled();
  });

  it("N4 降級：連線中 token 回 viewer → 留在 connected 但角色改變", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(tokenOk("editor")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    fetchMock.mockResolvedValue(tokenOk("viewer"));
    await act(async () => {
      await p.configuration.token();
    });
    expect(phase()).toBe("connected:viewer");
    expect(p.disconnect).not.toHaveBeenCalled();
  });

  it("close(NOTE_DELETED) → deleted 終態並停止重連", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("owner"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_NOTE_DELETED } }));
    expect(phase()).toBe("deleted");
    await waitFor(() => expect(p.disconnect).toHaveBeenCalled());
  });

  it("token endpoint 404 → deleted（重連時筆記已不存在的保險絲）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(apiFail(404, "not_found"))),
    );
    render(<Probe />);

    await act(async () => {
      await expect(provider().configuration.token()).rejects.toThrow();
    });
    expect(phase()).toBe("deleted");
  });

  // ── issue #6：authenticationFailed（server 的 permission-denied Auth 訊息）────────
  //
  // ⚠ 這一族的共同前提：Hocuspocus server 對 `onAuthenticate` 丟出的錯誤**只回一則
  // permission-denied 訊息，socket 原封不動留著**（已對 4.5.0 `ClientConnection` 原始碼
  // 核實），provider 也不會自己重連。沒接這個事件的話，畫面會永遠停在 connecting。

  it("撤權落在握手完成之前：authenticationFailed → 重連一次 → role 'none' → kicked", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(tokenOk("editor")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    // 還沒 onAuthenticated：server 在握手當下就拒了，client 收不到任何 CLOSE(REVOKED)。
    expect(phase()).toBe("connecting");

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_FORBIDDEN }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    expect(p.connect).not.toHaveBeenCalled();

    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(tokenOk("none"));
    await act(async () => {
      await p.configuration.token();
    });
    expect(phase()).toBe("kicked");
  });

  it("reconnecting-once 期間再收 authenticationFailed → kicked（第二擊）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");
    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_FORBIDDEN }));
    expect(phase()).toBe("kicked");
  });

  it("authenticationFailed(note-deleting) → deleted 終態（不繞第二擊）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("owner"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_NOTE_DELETING }));
    expect(phase()).toBe("deleted");
    await waitFor(() => expect(p.disconnect).toHaveBeenCalled());
  });

  it("token function 自己失敗換來的 authenticationFailed 不是授權裁決，不得踢人", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(apiFail(503, "server_busy"))),
    );
    render(<Probe />);
    const p = provider();

    const rejected = expect(p.configuration.token()).rejects.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await rejected;

    // provider 在 getToken() 的 catch 裡直接呼叫 permissionDeniedHandler（見 dist 的
    // `sendToken`）——reason 是本地字串而非 server 裁決；5xx/網路失敗不得踢人（N7）。
    act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));
    expect(phase()).toBe("connecting");
    expect(p.disconnect).not.toHaveBeenCalled();
  });

  it("換筆記：上一條連線遲到的 token 失敗不得吞掉新連線的授權拒絕", async () => {
    // 舊 provider 被 destroy 之後，它那一發**還卡在飛的** token 請求仍會丟錯回來（退避
    // 迴圈的 `disposed` 守衛只能讓它不再重試，召不回已經送出去的那一發）。「上一次取
    // token 失敗了」的旗標若是挂在 hook 層（`useRef`）而非每條連線各一份，那一丟會把它
    // 設回 true；而舊 provider 的 `authenticationFailed` 已因 `destroy()` 的
    // `removeAllListeners()` 無人接收、永遠不會把它清掉。新筆記真的在握手前被撤權時，
    // 那則拒絕就會被靜靜吞掉——issue #6 原封不動回來。
    //
    // ⚠ 必須是**同一個元件實例換 noteId**（rerender）才測得到：unmount 再
    // `render()` 是兩個元件實例、兩份獨立的 ref，滲漏本來就不會發生。
    let failStale!: (err: unknown) => void;
    const staleFetch = new Promise<Response>((_resolve, reject) => {
      failStale = reject;
    });
    const fetchMock = vi.fn(() => staleFetch);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<Probe noteId={NOTE_ID} />);
    const stale = provider(0);
    const staleToken = expect(stale.configuration.token()).rejects.toThrow();

    // 換到另一篇：同一個 hook 實例、全新的一場連線，token 這次取得成功。
    fetchMock.mockReturnValue(Promise.resolve(tokenOk("editor")) as unknown as Promise<Response>);
    rerender(<Probe noteId={OTHER_NOTE_ID} />);
    const fresh = provider(1);
    await act(async () => {
      await fresh.configuration.token();
    });

    // 舊那發現在才失敗。
    await act(async () => {
      failStale(new Error("network went away"));
      await staleToken;
    });

    act(() => fresh.emit("authenticationFailed", { reason: COLLAB_REJECT_FORBIDDEN }));
    expect(phase()).toBe("reconnecting-once");
  });

  it("authenticationFailed(invalid-token) 不是授權裁決：不得踢人，改排一次重啟（issue #35）", async () => {
    // token 驗不過、session 的 tokenVersion 被撤銷（帳號停用／別處改過密碼）、server 端
    // DB 抖動都會落在這一桶。舊版一律翻成撤權 ⇒ 對一個權限完好的使用者說「你已失去存取權」
    // 並把他導走。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    expect(phase()).toBe("connecting");
    expect(p.disconnect).not.toHaveBeenCalled();

    // 但也不能就這樣算了：socket 開著卻沒通過認證，provider 不會再取一次 token
    // （issue #34/#39 那一族的靜默死路）。第一格 5 秒之後整條連線重來。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("connecting");
  });

  it("authenticationFailed(server-error／不認得的 reason) 同樣不得踢人", async () => {
    // server 端未預期例外會被 Hocuspocus 翻成字面值 "permission-denied"（我們改成明確的
    // server-error，但舊 server／未來新 reason 都可能出現不認得的值）——一律歸「不是裁決」。
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_SERVER_ERROR }));
    expect(phase()).toBe("connecting");
    act(() => p.emit("authenticationFailed", { reason: "permission-denied" }));
    expect(phase()).toBe("connecting");
    // reason 缺席也一樣（`reason === undefined` 那個經典誤判）。
    act(() => p.emit("authenticationFailed", {}));
    expect(phase()).toBe("connecting");
  });

  it("reconnecting-once 期間收到 invalid-token：不算第二擊，也不破壞收斂（issue #35）", async () => {
    // 撤權觀察窗內收到一則「不是裁決」的拒絕——狀態不得前進到 kicked，排出去的那次重啟
    // 也不得跟狀態 effect 自己那次重啟互相打架（雙重 disconnect／吞掉 pending 旗標）。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn(() => Promise.resolve(tokenOk("editor")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    // 第一擊。
    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(1);

    // 重連的握手被 server 以 invalid-token 拒絕——留在觀察窗，不是第二擊。
    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    expect(phase()).toBe("reconnecting-once");

    // 重啟照排，且仍然帶得出重連。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(2);
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(2);

    // 真的被撤權時仍然收斂：重取的 token 回 'none' ⇒ 第二擊。
    fetchMock.mockResolvedValue(tokenOk("none"));
    await act(async () => {
      await p.configuration.token();
    });
    expect(phase()).toBe("kicked");
  });

  it("連上了就收掉還排著的重啟（否則那顆 timer 會把健康的連線拆掉重來）", async () => {
    // 拒連在 t=0 排了 5 秒後的重啟，而 server 其實很快就恢復、provider 內建退避先連上了。
    // 留著那顆 timer 的話，它會在 t=5 秒把一條健康的連線 disconnect，並多花一次
    // collab-token 額度（per-user、跨分頁共用）。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    expect(phase()).toBe("connecting");

    // provider 自己的退避先把連線救回來了。
    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(p.disconnect).not.toHaveBeenCalled();
    expect(phase()).toBe("connected:editor");
  });

  it("終態要掐掉**拒連**排出去的那次重啟（不只 token 失敗那條）", async () => {
    // stopRestartsRef 這道閘門在這個 commit 之後多了一個更常見的餵食者；沒有測試守著，
    // 一次整理就會讓終態的連線被 timer 重新拉起來（memory note 點名的不變量）。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("owner"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_SERVER_ERROR }));
    expect(phase()).toBe("connecting");

    // 重啟排好之後、開火之前，筆記被刪除 → 終態。
    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_NOTE_DELETED } }));
    expect(phase()).toBe("deleted");
    const disconnectsAtTerminal = p.disconnect.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    // 一次也不能再重連——否則就是一條沒人接事件的殭屍連線。
    expect(p.disconnect).toHaveBeenCalledTimes(disconnectsAtTerminal);
    expect(p.connect).not.toHaveBeenCalled();
    expect(phase()).toBe("deleted");
  });

  it("拒連驅動的重啟同樣一次比一次寬（退避格子與 token 失敗共用一份）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));

    // 第二次拒絕：不可以又在 5 秒後就來（server 還在壞，秒級重試只會加重它的負擔，
    // 而且 collab-token 的額度是跨分頁共用的）。
    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(2);
  });

  it("換筆記：上一篇遲到的 404 也不得把新筆記打成 deleted（issue #36 的另一半）", async () => {
    // 成功出口與 404 出口是同一個滲漏：兩者都會 dispatch 進 hook 層的狀態機。404 那一支
    // 打進去的是**終態** deleted——比錯誤角色更難救（使用者會被導離一篇還在的筆記）。
    let failStale!: (err: unknown) => void;
    const staleFetch = new Promise<Response>((_resolve, reject) => {
      failStale = reject;
    });
    const fetchMock = vi.fn(() => staleFetch);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<Probe noteId={NOTE_ID} />);
    const stale = provider(0);
    const staleToken = expect(stale.configuration.token()).rejects.toThrow();

    fetchMock.mockReturnValue(Promise.resolve(tokenOk("editor")) as unknown as Promise<Response>);
    rerender(<Probe noteId={OTHER_NOTE_ID} />);
    const fresh = provider(1);
    await act(async () => {
      await fresh.configuration.token();
    });
    act(() => fresh.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    // 上一篇那一發現在才回來，而且是 404（那篇筆記被刪了）。
    await act(async () => {
      failStale(new ApiFail(404, "not_found", "gone"));
      await staleToken;
    });
    expect(phase()).toBe("connected:editor");
  });

  it("換筆記：上一篇遲到的 token **成功**回應不得打進新筆記的狀態機（issue #36）", async () => {
    // `roleRef` 與 `dispatch` 都是 hook 層的（不隨 effect 重建），成功出口少了 `disposed`
    // 守衛的話，上一篇還在飛的那一發回來時會打進新筆記：新筆記若正在 reconnecting-once
    // （撤權觀察窗）而遲到的角色是上一篇的 'none'，就直接判成第二擊——使用者被踢出一篇
    // 他其實有權限的筆記。
    //
    // ⚠ 必須是**同一個元件實例換 noteId**（rerender）：unmount 再 render 是兩個元件實例、
    // 兩份獨立的 ref，滲漏本來就不會發生。
    let resolveStale!: (res: Response) => void;
    const staleFetch = new Promise<Response>(resolve => {
      resolveStale = resolve;
    });
    const fetchMock = vi.fn(() => staleFetch);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<Probe noteId={NOTE_ID} />);
    const stale = provider(0);
    const staleToken = stale.configuration.token();

    fetchMock.mockReturnValue(Promise.resolve(tokenOk("editor")) as unknown as Promise<Response>);
    rerender(<Probe noteId={OTHER_NOTE_ID} />);
    const fresh = provider(1);
    await act(async () => {
      await fresh.configuration.token();
    });
    act(() => fresh.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");

    // 新筆記進入撤權觀察窗。
    act(() => fresh.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");

    // 上一篇那一發現在才回來，帶著上一篇的角色 'none'。
    await act(async () => {
      resolveStale(tokenOk("none"));
      await staleToken;
    });
    expect(phase()).toBe("reconnecting-once");

    // roleRef 也不能被舊值蓋掉——否則緊接著的 open 會帶錯角色。
    act(() => fresh.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");
  });

  it("拒連原因常數與 server 端字面值一致", () => {
    // 共用包沒重建時這一組常數會是 undefined，於是 `reason === CONST` 靜靜地走錯分支
    // （本修改開發時就踩過）。釘住字面值，那種環境會大聲失敗而不是假綠。
    expect(COLLAB_REJECT_NOTE_DELETING).toBe("note-deleting");
    expect(COLLAB_REJECT_INVALID_TOKEN).toBe("invalid-token");
    expect(COLLAB_REJECT_FORBIDDEN).toBe("forbidden");
    expect(COLLAB_REJECT_SERVER_ERROR).toBe("server-error");
  });

  it("保險絲開火之後才回來的 close，仍然要帶出那一次重連（issue #34）", async () => {
    // `HocuspocusProviderWebsocket.connect()` 開頭是 `if (status === Connected) return`，
    // **而且那個 early return 發生在 `shouldConnect = true` 之前**。所以保險絲開火時若
    // socket 還沒真的關掉，那一發 connect() 是空轉；若保險絲順手把 pending 旗標清掉，
    // 稍後真正回來的 close 就會被當成一般斷線打回 `connecting`，而 provider 內建的退避
    // 因為 `shouldConnect === false` 也不會啟動 ⇒ socket 關了、沒有人重連、永遠停在
    // 「連線中」。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenOk("editor"))),
    );
    render(<Probe />);
    const p = provider();
    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.disconnect).toHaveBeenCalledTimes(1);

    // 保險絲開火（在真實 provider 上這一發可能完全空轉）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    // 真正的 close 現在才回來——它必須仍然帶出重連，而不是把狀態打回 connecting。
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(phase()).toBe("reconnecting-once");
    expect(p.connect).toHaveBeenCalledTimes(2);
  });

  it("token 全部重試用完之後，連線會自己重來一次，不是靜默卡死（issue #39）", async () => {
    // 退避表用完 → `fetchToken` 丟錯 → provider 在 `getToken()` 的 catch 裡直接呼叫
    // `permissionDeniedHandler`，**socket 不關、也不會再取一次 token**。我們刻意不把
    // 這一則 `authenticationFailed` 當成撤權（N7），於是狀態機收不到任何事件——沒有
    // 這條自我修復，畫面就永遠停在「連線中」，連 server 回來了也不會恢復。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 重啟間隔帶 ±25% 抖動（多分頁不要同相位重試）。把亂數釘在中點，delay 就回到標稱值，
    // 這條測試才不是在賭時序。
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn(() => Promise.resolve(apiFail(503, "server_busy")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();

    const rejected = expect(p.configuration.token()).rejects.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await rejected;
    act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));

    // 不得踢人（N7）。
    expect(phase()).toBe("connecting");
    expect(p.connect).not.toHaveBeenCalled();

    // 但要自己重來：等到重啟延遲（第一格 5 秒）之後，整個握手重跑一次
    // （disconnect → close → connect）。刻意停在 5.5 秒——再多 0.5 秒就會連保險絲
    // （重啟後 1 秒）也一起開火，那樣就分不出「close 帶出的重連」與「保險絲補的那一發」。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("connecting");
  });

  it("重啟之後 token 終於成功 → 真的連上（自我修復要收斂，不只是「有再試」）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn(() => Promise.resolve(apiFail(503, "server_busy")));
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    const p = provider();

    const rejected = expect(p.configuration.token()).rejects.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await rejected;
    act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));

    // server 修好了。
    fetchMock.mockResolvedValue(tokenOk("editor"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));

    await act(async () => {
      await p.configuration.token();
    });
    act(() => p.configuration.onAuthenticated());
    expect(phase()).toBe("connected:editor");
  });

  it("重啟退避一次比一次寬（第二次不會又在 5 秒後就來）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(apiFail(503, "server_busy"))),
    );
    render(<Probe />);
    const p = provider();

    const failOnce = async () => {
      const rejected = expect(p.configuration.token()).rejects.toThrow();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await rejected;
      act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));
    };

    await failOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);

    await failOnce();
    // 第二格是 15 秒——6 秒時還不該來（退避表若被寫死成同一個值，這裡就會紅）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(p.disconnect).toHaveBeenCalledTimes(2);
  });

  it("卸載會把排好的重啟一起帶走（否則會留下沒人接的殭屍連線）", async () => {
    // `provider.destroy()` 之後那條 provider 的事件監聽器全被移除、連線檢查 interval 也停了。
    // 這時若還有一個漏掉的 timer 去 `connect()`，它會真的開一條新的 WebSocket——而且沒有任何
    // 人接它的事件，換一次筆記就漏一條。cleanup 的行序（先清 timer 再 destroy）靠這條守著。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(apiFail(503, "server_busy"))),
    );
    const { unmount } = render(<Probe />);
    const p = provider();

    const rejected = expect(p.configuration.token()).rejects.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await rejected;
    act(() => p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiFail" }));

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(p.connect).not.toHaveBeenCalled();
  });

  it("卸載時銷毀 provider", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { unmount } = render(<Probe />);
    const p = provider();
    unmount();
    expect(p.destroy).toHaveBeenCalledTimes(1);
  });
});
