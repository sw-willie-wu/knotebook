import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFail } from "@/api/client";
import { FakeXhr, installFakeXhr, lastXhr } from "@/test/fake-xhr";
import { xhrUpload } from "./xhr-upload";

const OK = { id: "u1", url: "/api/uploads/u1", mime: "video/mp4", kind: "video" };

beforeEach(() => installFakeXhr());
afterEach(() => vi.unstubAllGlobals());

describe("xhrUpload", () => {
  it("posts the form with credentials and resolves with the parsed body", async () => {
    const form = new FormData();
    const p = xhrUpload("/api/notes/n1/uploads", form);
    const x = lastXhr();
    expect(x.method).toBe("POST");
    expect(x.url).toBe("/api/notes/n1/uploads");
    expect(x.withCredentials).toBe(true);
    expect(x.body).toBe(form);
    x.respond(201, OK);
    await expect(p).resolves.toEqual(OK);
  });

  it("any 2xx status resolves, not only 201", async () => {
    const p = xhrUpload("/x", new FormData());
    lastXhr().respond(200, OK);
    await expect(p).resolves.toEqual(OK);
  });

  it("reports progress through onProgress", async () => {
    const onProgress = vi.fn();
    const p = xhrUpload("/x", new FormData(), { onProgress });
    lastXhr().progress(10, 100);
    lastXhr().progress(60, 100);
    expect(onProgress.mock.calls).toEqual([
      [10, 100],
      [60, 100],
    ]);
    lastXhr().respond(201, OK);
    await p;
  });

  it("ignores progress events without a computable length", async () => {
    const onProgress = vi.fn();
    const p = xhrUpload("/x", new FormData(), { onProgress });
    lastXhr().upload.onprogress?.({ lengthComputable: false, loaded: 5, total: 0 });
    expect(onProgress).not.toHaveBeenCalled();
    lastXhr().respond(201, OK);
    await p;
  });

  it.each([
    [413, { error: { code: "file_too_large", message: "big" } }],
    [415, { error: { code: "unsupported_media_type", message: "nope" } }],
  ])("%i body maps to the same ApiFail as api()", async (status, body) => {
    const p = xhrUpload("/x", new FormData());
    lastXhr().respond(status, body);
    await expect(p).rejects.toMatchObject({ status, code: body.error.code });
    await expect(p).rejects.toBeInstanceOf(ApiFail);
  });

  it("409 carries storage detail and retryAfterMs like api()", async () => {
    const p = xhrUpload("/x", new FormData());
    lastXhr().respond(409, {
      error: { code: "storage_quota_exceeded", message: "full" },
      storage: { incomingBytes: 700, usedBytes: 5, quotaBytes: 10 },
      retryAfterMs: 1500,
    });
    await expect(p).rejects.toMatchObject({
      status: 409,
      code: "storage_quota_exceeded",
      storage: { incomingBytes: 700, usedBytes: 5, quotaBytes: 10 },
      retryAfterMs: 1500,
    });
  });

  it("401 rejects with ApiFail(401)", async () => {
    const p = xhrUpload("/x", new FormData());
    lastXhr().respond(401, { error: { code: "unauthorized", message: "no" } });
    await expect(p).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("a non-JSON error body becomes ApiFail internal", async () => {
    const p = xhrUpload("/x", new FormData());
    lastXhr().respond(502, "<html>bad gateway</html>");
    await expect(p).rejects.toMatchObject({ status: 502, code: "internal" });
  });

  it("a network error rejects with upload_interrupted (status 0)", async () => {
    const p = xhrUpload("/x", new FormData());
    lastXhr().onerror?.();
    await expect(p).rejects.toMatchObject({ status: 0, code: "upload_interrupted" });
    await expect(p).rejects.toBeInstanceOf(ApiFail);
  });

  it("a timeout rejects with upload_interrupted", async () => {
    const p = xhrUpload("/x", new FormData());
    lastXhr().ontimeout?.();
    await expect(p).rejects.toMatchObject({ status: 0, code: "upload_interrupted" });
  });

  it("aborting the signal aborts the request and rejects with AbortError", async () => {
    const ctl = new AbortController();
    const p = xhrUpload("/x", new FormData(), { signal: ctl.signal });
    ctl.abort();
    expect(lastXhr().aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an already-aborted signal rejects without creating a request", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(xhrUpload("/x", new FormData(), { signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.instances).toHaveLength(0);
  });
});
