import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "__fixtures__", "vllm-sse.txt");

// vi.mock 會被 vitest hoist 到檔案最前面（先於下面的具名 import），所以 `streamAnthropic`
// 匯入時拿到的必然是這支 mock 版本——不需要手動調整 import 順序。
vi.mock("@anthropic-ai/sdk", () => {
  const streamMock = vi.fn();
  const ctorMock = vi.fn().mockImplementation(() => ({ messages: { stream: streamMock } }));
  return { default: ctorMock, __streamMock: streamMock, __ctorMock: ctorMock };
});

import { renderUserTemplate, streamAnthropic, streamOpenAiCompatible, UpstreamError } from "../../src/ai/upstream.js";

/** 把字串在指定 byte offset 切成兩個 chunk 餵給 ReadableStream——用來逼真模擬「一行 SSE
 * event 跨 chunk 邊界斷開」的情境（brief 明點的 vLLM fixture 測試重點）。 */
function chunkedTextStream(text: string, splitAt: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const first = bytes.slice(0, splitAt);
  const second = bytes.slice(splitAt);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      controller.enqueue(second);
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of stream) out.push(delta);
  return out;
}

describe("streamOpenAiCompatible", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("vLLM fixture：只吐 content，reasoning_content 全濾，跨 chunk 斷行的一行仍正確重組", async () => {
    const fixture = readFileSync(FIXTURE_PATH, "utf8");
    // 刻意切在其中一行 JSON 的中間（"Hello" 這個 delta 的行內），而非任何 chunk 天然的換行處。
    const splitAt = fixture.indexOf('"content":"Hello"') + 5;
    expect(splitAt).toBeGreaterThan(5); // 確認錨點真的在 fixture 裡找到

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(chunkedTextStream(fixture, splitAt), { status: 200, headers: { "content-type": "text/event-stream" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local/v1",
      apiKey: "sk-test",
      model: "vllm-model",
      system: "sys",
      user: "usr",
      signal: new AbortController().signal,
    });

    const deltas = await collect(handle.stream);
    expect(deltas.join("")).toBe("Hello, world!");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://upstream.local/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string) as { model: string; stream: boolean; messages: unknown[] };
    expect(body.model).toBe("vllm-model");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("apiKey 未提供時不帶 authorization header（本機/無驗證 vLLM）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(chunkedTextStream("data: [DONE]\n\n", 5), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local",
      model: "m",
      system: "s",
      user: "u",
      signal: new AbortController().signal,
    });
    await collect(handle.stream);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("非 2xx → UpstreamError(status)，message 固定文案不含上游 body 內容", async () => {
    const sentinelBody = "SENTINEL-UPSTREAM-BODY-should-not-leak-into-message";
    const fetchMock = vi.fn().mockResolvedValue(new Response(sentinelBody, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local",
      model: "m",
      system: "s",
      user: "u",
      signal: new AbortController().signal,
    });

    let caught: unknown;
    try {
      await collect(handle.stream);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UpstreamError);
    const err = caught as UpstreamError;
    expect(err.status).toBe(502);
    expect(err.message).toBe("upstream request failed");
    expect(err.message).not.toContain(sentinelBody);
    // upstreamBody 是給呼叫端 log 用的額外欄位（不是拋給 client 的 SSE 訊息）——這裡才允許含身體內容。
    expect(err.upstreamBody).toContain(sentinelBody);
  });

  it("上游錯誤 body 超過 2048 字元時截斷並附註記", async () => {
    const hugeBody = "x".repeat(3000);
    const fetchMock = vi.fn().mockResolvedValue(new Response(hugeBody, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local",
      model: "m",
      system: "s",
      user: "u",
      signal: new AbortController().signal,
    });

    let caught: unknown;
    try {
      await collect(handle.stream);
    } catch (err) {
      caught = err;
    }
    const err = caught as UpstreamError;
    expect(err.upstreamBody?.length).toBeLessThan(3000);
    expect(err.upstreamBody).toContain("...(truncated)");
  });

  it("signal 已 abort 時仍可建立 handle，串流因中止而丟出錯誤（不會卡住）", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    const handle = streamOpenAiCompatible({
      baseUrl: "http://upstream.local",
      model: "m",
      system: "s",
      user: "u",
      signal: controller.signal,
    });

    await expect(collect(handle.stream)).rejects.toBeTruthy();
  });
});

describe("streamAnthropic", () => {
  beforeEach(async () => {
    const mod = (await import("@anthropic-ai/sdk")) as unknown as {
      __streamMock: ReturnType<typeof vi.fn>;
      __ctorMock: ReturnType<typeof vi.fn>;
    };
    mod.__streamMock.mockReset();
    mod.__ctorMock.mockClear();
  });

  it("只轉發 content_block_delta 的 text_delta；thinking_delta 等其餘事件全濾", async () => {
    const mod = (await import("@anthropic-ai/sdk")) as unknown as { __streamMock: ReturnType<typeof vi.fn> };
    async function* fakeEvents() {
      yield { type: "message_start" };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret reasoning, never forward" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
      yield { type: "message_stop" };
    }
    mod.__streamMock.mockReturnValue(fakeEvents());

    const handle = streamAnthropic({
      apiKey: "sk-ant-test",
      model: "claude-x",
      system: "sys",
      user: "usr",
      signal: new AbortController().signal,
    });

    const deltas = await collect(handle.stream);
    expect(deltas.join("")).toBe("Hello");
    for (const d of deltas) expect(d).not.toContain("secret reasoning");
  });

  it("以 apiKey/baseUrl 建構 SDK client；stream() 帶 model/max_tokens/system/messages", async () => {
    const mod = (await import("@anthropic-ai/sdk")) as unknown as {
      __streamMock: ReturnType<typeof vi.fn>;
      __ctorMock: ReturnType<typeof vi.fn>;
    };
    async function* fakeEvents() {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
    }
    mod.__streamMock.mockReturnValue(fakeEvents());

    const handle = streamAnthropic({
      apiKey: "sk-ant-test",
      baseUrl: "https://custom.anthropic.example",
      model: "claude-x",
      system: "sys",
      user: "usr",
      signal: new AbortController().signal,
    });
    await collect(handle.stream);

    // fix round 1 I-1（安全）：ctor 必須帶 `fetchOptions: { redirect: "manual" }`，理由同
    // Task 4 審查 I-4——SDK 自帶的 `x-api-key` 不在 undici 轉址剝除清單內，302 會把明文 key
    // 原樣送去第三方主機；審查者用真 SDK + 302 repro 實測過，加了這個選項才是零外送。
    expect(mod.__ctorMock).toHaveBeenCalledWith({
      apiKey: "sk-ant-test",
      baseURL: "https://custom.anthropic.example",
      fetchOptions: { redirect: "manual" },
    });
    const [params, options] = mod.__streamMock.mock.calls[0] as [
      { model: string; max_tokens: number; system: string; messages: unknown[] },
      { signal: AbortSignal },
    ];
    expect(params.model).toBe("claude-x");
    expect(params.system).toBe("sys");
    expect(params.messages).toEqual([{ role: "user", content: "usr" }]);
    expect(typeof params.max_tokens).toBe("number");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("renderUserTemplate", () => {
  it("多個佔位符皆替換", () => {
    expect(renderUserTemplate("A {{text}} B {{text}} C", "X")).toBe("A X B X C");
  });

  it("無佔位符時原樣返回", () => {
    expect(renderUserTemplate("no placeholder here", "X")).toBe("no placeholder here");
  });

  it("替換值含 $ 特殊字元時逐字元原樣貼回（不觸發 replaceAll 替換模式解析：$$、$&、反引號變體、$'）", () => {
    const weird = "$$ and $& and $` and $' and ${template literal} and $<name>";
    expect(renderUserTemplate("before {{text}} after", weird)).toBe(`before ${weird} after`);
  });

  it("空字串替換值：佔位符被移除，其餘文字不變", () => {
    expect(renderUserTemplate("[{{text}}]", "")).toBe("[]");
  });
});
