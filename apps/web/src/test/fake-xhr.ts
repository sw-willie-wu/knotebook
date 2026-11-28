import { vi } from "vitest";

/** Minimal XMLHttpRequest stand-in: tests drive the lifecycle by hand through the instance list. */
export class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  withCredentials = false;
  responseType = "";
  status = 0;
  responseText = "";
  body: unknown = null;
  aborted = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  send(body: unknown): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
}

export function installFakeXhr(): void {
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
}

export function lastXhr(): FakeXhr {
  const x = FakeXhr.instances.at(-1);
  if (!x) throw new Error("no XHR was created");
  return x;
}

/**
 * Routes XHR uploads through whatever `fetch` is stubbed at send time, so tests written against a fetch mock keep
 * asserting on the request (method, body) and the canned response without driving an XHR by hand.
 */
export function installFetchBackedXhr(): void {
  class FetchBackedXhr extends FakeXhr {
    override send(body: unknown): void {
      this.body = body;
      void globalThis
        .fetch(this.url, { method: this.method, body: body as BodyInit, credentials: "include" })
        .then(async (res) => {
          this.status = res.status;
          try {
            this.responseText = JSON.stringify(await res.json());
          } catch {
            this.responseText = "";
          }
          this.onload?.();
        }, () => this.onerror?.());
    }
  }
  vi.stubGlobal("XMLHttpRequest", FetchBackedXhr);
}
