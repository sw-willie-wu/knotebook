import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  COLLAB_CLOSE_NOTE_DELETED,
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_INVALID_TOKEN,
  COLLAB_REJECT_NOTE_DELETING,
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

    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
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
    act(() => p.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
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
    // 那則拒絕就會被静静吞掉——issue #6 原封不動回來。
    //
    // ⚠ 必須是**同一個元件實例換 noteId**（rerender）才測得到：unmount 再
    // `render()` 是兩個元件實例、兩份獨立的 ref，渗漏本來就不會發生。
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

    act(() => fresh.emit("authenticationFailed", { reason: COLLAB_REJECT_INVALID_TOKEN }));
    expect(phase()).toBe("reconnecting-once");
  });

  it("拒連原因常數與 server 端字面值一致", () => {
    // 共用包沒重建時這一組常數會是 undefined，於是 `reason === CONST` 静静地走錯分支
    // （本修改開發時就踩過）。釘住字面值，那種環境會大聲失敗而不是假綠。
    expect(COLLAB_REJECT_NOTE_DELETING).toBe("note-deleting");
    expect(COLLAB_REJECT_INVALID_TOKEN).toBe("invalid-token");
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
