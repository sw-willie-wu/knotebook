import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFail } from "./client";
import { streamAiAction } from "./ai";

/**
 * `POST /api/ai` 的手寫 SSE client（spec §13.2/§13.5-1）。`fetch` 整個被 stub 掉，
 * 用一個真的 `ReadableStream<Uint8Array>` 模擬 server 端 `raw.write("event: ...\ndata:
 * ...\n\n")` 的位元組流——包含跨 chunk 斷行的情形（M3 的核心風險：`event: delta\n` 跟
 * `data: {...}\n\n` 被切在兩次 `reader.read()` 裡）。
 */

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 把整段 SSE 文字依 `chunks` 指定的切點切開，模擬多次 `reader.read()` 回傳。 */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encode(chunk));
      controller.close();
    },
  });
}

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  body?: ReadableStream<Uint8Array> | null;
}

function fakeResponse({ ok, status, json, body }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
    body: body ?? null,
  } as unknown as Response;
}

describe("streamAiAction（手寫 SSE client）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("多 chunk 斷行重組：event/data 被切在不同 chunk 裡仍能正確組回並逐一回呼 delta", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          body: sseBody([
            "event: delta\n",
            'data: {"text":"你好"}\n\n',
            'event: delta\ndata: {"text":"，世界"}',
            "\n\n",
            "event: done\ndata: {}\n\n",
          ]),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    await streamAiAction({
      actionId: "a1",
      noteId: "n1",
      text: "hi",
      signal: new AbortController().signal,
      onDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual(["你好", "，世界"]);
  });

  it("delta 逐一回呼：三個 delta 事件依序觸發三次 onDelta", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          body: sseBody([
            'event: delta\ndata: {"text":"A"}\n\n',
            'event: delta\ndata: {"text":"B"}\n\n',
            'event: delta\ndata: {"text":"C"}\n\n',
            "event: done\ndata: {}\n\n",
          ]),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    await streamAiAction({
      actionId: "a1",
      noteId: "n1",
      text: "hi",
      signal: new AbortController().signal,
      onDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual(["A", "B", "C"]);
  });

  it("error 事件 → 丟 ApiFail(code, message)，不再繼續讀取", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          body: sseBody(['event: error\ndata: {"code":"upstream_error","message":"upstream request failed"}\n\n']),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onDelta = vi.fn();
    await expect(
      streamAiAction({ actionId: "a1", noteId: "n1", text: "hi", signal: new AbortController().signal, onDelta }),
    ).rejects.toMatchObject(new ApiFail(200, "upstream_error", "upstream request failed"));
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("pre-stream 503 JSON → ApiFail('ai_not_configured')", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        fakeResponse({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: { code: "ai_not_configured", message: "AI 尚未設定，請聯絡管理員" } }),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      streamAiAction({
        actionId: "a1",
        noteId: "n1",
        text: "hi",
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toMatchObject(new ApiFail(503, "ai_not_configured", "AI 尚未設定，請聯絡管理員"));
  });

  it("abort：傳入的 AbortSignal 原封不動轉交給 fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, body: sseBody(["event: done\ndata: {}\n\n"]) })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamAiAction({ actionId: "a1", noteId: "n1", text: "hi", signal: controller.signal, onDelta: vi.fn() });

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("送出的 init 帶 Content-Type: application/json 與 credentials: include（M3 護欄）", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, body: sseBody(["event: done\ndata: {}\n\n"]) })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamAiAction({
      actionId: "a1",
      noteId: "n1",
      text: "hi",
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });

    const [url, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(url).toBe("/api/ai");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ action_id: "a1", note_id: "n1", text: "hi" });
  });
});
