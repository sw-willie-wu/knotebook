import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTextPreview, TEXT_PREVIEW_BYTES } from "./text-preview";

const TEXT = "text/plain; charset=utf-8";
const MIB = 1024 * 1024;

function respond(status: number, body: BodyInit | null, headers: Record<string, string>) {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(body, { status, headers })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadTextPreview", () => {
  it("asks for the first 1 MiB with the session cookie", async () => {
    const fetchMock = respond(206, "alpha,1", { "content-type": TEXT, "content-range": "bytes 0-6/7" });
    await loadTextPreview("/api/uploads/u1");
    expect(TEXT_PREVIEW_BYTES).toBe(1_048_576);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("/api/uploads/u1");
    expect(new Headers(init.headers).get("range")).toBe("bytes=0-1048575");
    expect(init.credentials).toBe("same-origin");
  });

  it("a file within 1 MiB: the whole text, not truncated", async () => {
    respond(206, "alpha,1\nbeta,2\n", { "content-type": TEXT, "content-range": "bytes 0-14/15" });
    expect(await loadTextPreview("/api/uploads/u1")).toEqual({ text: "alpha,1\nbeta,2\n", truncated: false });
  });

  it("exactly 1 MiB is not truncated; one byte more is", async () => {
    respond(206, "a".repeat(MIB), { "content-type": TEXT, "content-range": `bytes 0-${MIB - 1}/${MIB}` });
    expect((await loadTextPreview("/api/uploads/u1")).truncated).toBe(false);
    respond(206, "a".repeat(MIB), { "content-type": TEXT, "content-range": `bytes 0-${MIB - 1}/${MIB + 1}` });
    expect((await loadTextPreview("/api/uploads/u1")).truncated).toBe(true);
  });

  it("a 200 (range ignored on the way) reads only the first 1 MiB; Content-Length says it is longer", async () => {
    const body = new Uint8Array(MIB + 10).fill(0x62);
    respond(200, body, { "content-type": TEXT, "content-length": String(body.length) });
    const result = await loadTextPreview("/api/uploads/u1");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(MIB);
  });

  it("a chunked 200 with no length: a first chunk of exactly 1 MiB with more after it is truncated; exactly 1 MiB in all is not", async () => {
    const stream = (chunks: Uint8Array[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          controller.close();
        },
      });
    respond(200, stream([new Uint8Array(MIB).fill(0x61), new Uint8Array(5).fill(0x62)]), { "content-type": TEXT });
    const more = await loadTextPreview("/api/uploads/u1");
    expect(more.truncated).toBe(true);
    expect(more.text.length).toBe(MIB);
    respond(200, stream([new Uint8Array(MIB).fill(0x61)]), { "content-type": TEXT });
    expect((await loadTextPreview("/api/uploads/u1")).truncated).toBe(false);
  });

  it("a character cut at the 1 MiB boundary is dropped, not shown as a replacement character", async () => {
    const bytes = new Uint8Array(MIB);
    bytes.fill(0x61, 0, MIB - 2);
    bytes.set([0xe4, 0xb8], MIB - 2); // the first two bytes of a three-byte character
    respond(206, bytes, { "content-type": TEXT, "content-range": `bytes 0-${MIB - 1}/${MIB + 1}` });
    const result = await loadTextPreview("/api/uploads/u1");
    expect(result.text.endsWith("a")).toBe(true);
    expect(result.text).not.toContain("�");
  });

  it("invalid UTF-8 inside the text decodes with replacement characters instead of failing", async () => {
    respond(206, new Uint8Array([0x61, 0xff, 0x62]), { "content-type": TEXT, "content-range": "bytes 0-2/3" });
    expect((await loadTextPreview("/api/uploads/u1")).text).toBe("a�b");
  });

  it("an empty file (416 with a total of 0) is empty text", async () => {
    respond(416, null, { "content-range": "bytes */0" });
    expect(await loadTextPreview("/api/uploads/u1")).toEqual({ text: "", truncated: false });
  });

  it.each([403, 404, 416, 500])("%i fails", async (status) => {
    respond(status, null, { "content-type": "application/json; charset=utf-8", "content-range": "bytes */20" });
    await expect(loadTextPreview("/api/uploads/u1")).rejects.toThrow();
  });

  it.each(["application/pdf", "text/csv", "text/plain", "text/plain; charset=iso-8859-1", ""])("content type %j fails (only the inline UTF-8 text class shows)", async (type) => {
    respond(206, "x", { "content-type": type, "content-range": "bytes 0-0/1" });
    await expect(loadTextPreview("/api/uploads/u1")).rejects.toThrow();
  });

  it("a network error fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(loadTextPreview("/api/uploads/u1")).rejects.toThrow();
  });
});
