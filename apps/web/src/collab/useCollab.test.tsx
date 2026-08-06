import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED } from "@knotebook/shared";

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

function Probe({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const { state } = useCollab({ noteId: NOTE_ID, onUnauthorized: onUnauthorized ?? (() => {}) });
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
