import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiFail } from "./client";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

describe("api()", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends credentials: 'include' and no Content-Type on a plain GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ hello: "world" }) }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api<{ hello: string }>("/api/notes");

    expect(result).toEqual({ hello: "world" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/notes");
    expect(init.credentials).toBe("include");
    expect((init.headers as Headers).has("Content-Type")).toBe(false);
  });

  it("adds Content-Type: application/json on mutating requests that didn't set one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({}) }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/api/notes", { method: "POST", body: JSON.stringify({ title: "x" }) });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("does NOT set Content-Type on a body-less mutation (e.g. POST /api/auth/logout)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/api/auth/logout", { method: "POST" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).has("Content-Type")).toBe(false);
  });

  it("does NOT set Content-Type on a FormData body (browser must set the multipart boundary itself)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({}) }));
    vi.stubGlobal("fetch", fetchMock);

    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
    await api("/api/notes/n1/uploads", { method: "POST", body: fd });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).has("Content-Type")).toBe(false);
    expect(init.body).toBe(fd);
  });

  it("does not override a caller-provided Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({}) }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/api/notes", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get("Content-Type")).toBe("text/plain");
  });

  it("returns undefined for a 204 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api("/api/notes/1", { method: "DELETE" });

    expect(result).toBeUndefined();
  });

  it("throws ApiFail preserving status/code/message from {error:{code,message}}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: { code: "forbidden", message: "nope" } }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await api("/api/notes/1");
      expect.unreachable("api() should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiFail);
      const fail = err as ApiFail;
      expect(fail.status).toBe(403);
      expect(fail.code).toBe("forbidden");
      expect(fail.message).toBe("nope");
    }
  });

  it("preserves top-level retryAfterMs (login 429 too_many_attempts)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: { code: "too_many_attempts", message: "slow down" },
            retryAfterMs: 30_000,
          }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await api("/api/auth/login", { method: "POST", body: "{}" });
      expect.unreachable("api() should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiFail);
      const fail = err as ApiFail;
      expect(fail.status).toBe(429);
      expect(fail.code).toBe("too_many_attempts");
      expect(fail.retryAfterMs).toBe(30_000);
    }
  });

  it("leaves retryAfterMs undefined when the body doesn't include it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: { code: "bad_request", message: "nope" } }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await api("/api/notes");
      expect.unreachable("api() should have thrown");
    } catch (err) {
      expect((err as ApiFail).retryAfterMs).toBeUndefined();
    }
  });

  it("falls back to code 'internal' when the error body is not JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 500,
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await api("/api/notes");
      expect.unreachable("api() should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiFail);
      expect((err as ApiFail).code).toBe("internal");
    }
  });

  it("falls back to code 'internal' when the JSON body doesn't match {error:{code,message}}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ oops: true }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await api("/api/notes");
      expect.unreachable("api() should have thrown");
    } catch (err) {
      expect((err as ApiFail).code).toBe("internal");
    }
  });
});
