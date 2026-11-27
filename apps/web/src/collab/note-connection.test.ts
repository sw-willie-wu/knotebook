import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { Doc as YDoc } from "yjs";
import type * as Y from "yjs";
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, COLLAB_REJECT_CLIENT_OUTDATED } from "@knotebook/shared";

// Same fake as `useCollab.test.tsx`, plus a real Awareness so presence clearing is observable.
interface FakeProvider {
  configuration: { token: () => Promise<string>; onAuthenticated: () => void; document: Y.Doc };
  emit: (event: string, payload: unknown) => void;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  awareness: Awareness;
  synced: boolean;
}

const hoisted = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness: RealAwareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      configuration: { document: Y.Doc };
      listeners = new Map<string, ((payload: unknown) => void)[]>();
      disconnect = vi.fn();
      connect = vi.fn();
      destroy = vi.fn();
      awareness: Awareness;
      synced = false;
      constructor(configuration: { document: Y.Doc }) {
        this.configuration = configuration;
        this.awareness = new RealAwareness(configuration.document);
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
  };
});

const { acquireNoteConnection } = await import("./note-connection");
const { useCollab } = await import("./useCollab");

const NOTE_ID = "11111111-1111-1111-1111-111111111111";

const provider = (index = 0) => hoisted.instances[index] as FakeProvider;

function fakeResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}
const tokenOk = (role: string) => fakeResponse(true, 200, { token: "jwt", role });
const apiFail = (status: number, code: string) => fakeResponse(false, status, { error: { code, message: "x" } });

const queueHolder = (onUnauthorized: () => void = () => {}) => ({ kind: "queue" as const, onUnauthorized });
const editorHolder = (onUnauthorized: () => void = () => {}) => ({ kind: "editor" as const, onUnauthorized });

async function connectAs(p: FakeProvider, role: string, fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockResolvedValue(tokenOk(role));
  await act(async () => {
    await p.configuration.token();
  });
  act(() => p.configuration.onAuthenticated());
}

function sync(p: FakeProvider) {
  p.synced = true;
  act(() => p.emit("synced", { state: true }));
}

const settled = async <T>(promise: Promise<T>): Promise<T | "pending"> => {
  let result: T | "pending" = "pending";
  void promise.then((v) => (result = v));
  await act(async () => {
    await Promise.resolve();
  });
  return result;
};

// A failed assertion must not leave the note's registry entry behind for the next test.
const handles: { release(): void }[] = [];
const track = <T extends { release(): void }>(handle: T): T => {
  handles.push(handle);
  return handle;
};

describe("acquireNoteConnection", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hoisted.instances.length = 0;
    fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.release();
    vi.unstubAllGlobals();
  });

  it("an editor and the queue on one note share one doc and provider", () => {
    const queue = track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const editor = track(acquireNoteConnection(NOTE_ID, editorHolder()));
    expect(hoisted.instances).toHaveLength(1);
    expect(editor.doc).toBe(queue.doc);
    expect(editor.provider).toBe(queue.provider);
  });

  it("hasEditor tells every holder whether an editor is attached right now", () => {
    const queue = track(acquireNoteConnection(NOTE_ID, queueHolder()));
    expect(queue.hasEditor()).toBe(false);
    const first = track(acquireNoteConnection(NOTE_ID, editorHolder()));
    const second = track(acquireNoteConnection(NOTE_ID, editorHolder()));
    expect(queue.hasEditor()).toBe(true);
    first.release();
    expect(queue.hasEditor()).toBe(true);
    second.release();
    expect(queue.hasEditor()).toBe(false);
  });

  it("the last release destroys the provider and doc; a later acquire opens a new connection", () => {
    const queue = acquireNoteConnection(NOTE_ID, queueHolder());
    const editor = acquireNoteConnection(NOTE_ID, editorHolder());
    const doc = queue.doc;
    const destroyDoc = vi.spyOn(doc, "destroy");
    editor.release();
    expect(provider().destroy).not.toHaveBeenCalled();
    queue.release();
    queue.release();
    expect(provider().destroy).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);

    const again = track(acquireNoteConnection(NOTE_ID, queueHolder()));
    expect(hoisted.instances).toHaveLength(2);
    expect(again.doc).not.toBe(doc);
  });

  const cursor = { anchor: { type: null, tname: "prosemirror", item: null, assoc: 0 }, head: { type: null, tname: "prosemirror", item: null, assoc: 0 } };
  const user = { name: "alice", color: "#000" };
  const knotebook = { v: 1, kind: "user", role: "editor" };

  it("editor released while the queue holds: provider stays, presence stays, the cursor becomes null", () => {
    track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const editor = acquireNoteConnection(NOTE_ID, editorHolder());
    const awareness = provider().awareness;
    awareness.setLocalStateField("user", user);
    awareness.setLocalStateField("knotebook", knotebook);
    awareness.setLocalStateField("cursor", cursor);

    editor.release();
    expect(provider().destroy).not.toHaveBeenCalled();
    expect(awareness.getLocalState()).toEqual({ user, knotebook, cursor: null });

    // y-prosemirror's cursor plugin writes this when BlockNote destroys the view, ticks after the release.
    awareness.setLocalStateField("cursor", null);
    expect(awareness.getLocalState()).toEqual({ user, knotebook, cursor: null });
  });

  it("editor released without a published cursor while the queue holds: the state is left as it was", () => {
    track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const editor = acquireNoteConnection(NOTE_ID, editorHolder());
    editor.release();
    expect(provider().awareness.getLocalState()).toEqual({});
  });

  it("an editor attaching again publishes its cursor again", () => {
    track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const first = acquireNoteConnection(NOTE_ID, editorHolder());
    const awareness = provider().awareness;
    awareness.setLocalStateField("user", user);
    awareness.setLocalStateField("cursor", cursor);
    first.release();
    track(acquireNoteConnection(NOTE_ID, editorHolder()));
    awareness.setLocalStateField("cursor", cursor);
    expect(awareness.getLocalState()).toEqual({ user, cursor });
  });

  it("reconnect while only the queue holds: a peer sees the person again without waiting for the renewal", async () => {
    track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const editor = acquireNoteConnection(NOTE_ID, editorHolder());
    const p = provider();
    await connectAs(p, "editor", fetchMock);
    const awareness = p.awareness;
    // The peer stands in for the server and other viewers: it applies whatever this tab sends.
    const peer = new Awareness(new YDoc());
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      applyAwarenessUpdate(peer, encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]), "server");
    });
    awareness.setLocalStateField("user", user);
    awareness.setLocalStateField("knotebook", knotebook);
    editor.release();
    expect(peer.getStates().get(awareness.clientID)).toEqual({ user, knotebook });

    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    // The old connection's close drops the state for others without touching its clock.
    removeAwarenessStates(peer, [awareness.clientID], "server");
    // The reopen's resend carries the old clock and is ignored.
    applyAwarenessUpdate(peer, encodeAwarenessUpdate(awareness, [awareness.clientID]), "server");
    expect(peer.getStates().has(awareness.clientID)).toBe(false);

    await connectAs(p, "editor", fetchMock);
    expect(peer.getStates().get(awareness.clientID)).toEqual({ user, knotebook });
    peer.destroy();
  });

  it("reconnect of a connection the queue opened on its own still publishes nothing", async () => {
    track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const p = provider();
    await connectAs(p, "editor", fetchMock);
    const clock = p.awareness.meta.get(p.awareness.clientID)?.clock;
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    await connectAs(p, "editor", fetchMock);
    expect(p.awareness.meta.get(p.awareness.clientID)?.clock).toBe(clock);
    expect(p.awareness.getLocalState()).toEqual({});
  });

  it("a connection the queue opened on its own publishes nothing through connect, auth and sync", async () => {
    track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const p = provider();
    await connectAs(p, "editor", fetchMock);
    sync(p);
    expect(p.awareness.getLocalState()).toEqual({});
  });

  it("whenWritable waits for an editor role and the first sync, then resolves ok", async () => {
    const queue = track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const p = provider();
    const writable = queue.whenWritable();
    expect(await settled(writable)).toBe("pending");
    await connectAs(p, "editor", fetchMock);
    expect(await settled(writable)).toBe("pending");
    sync(p);
    expect(await settled(writable)).toBe("ok");
    expect(await queue.whenWritable()).toBe("ok");
  });

  it("whenWritable for a viewer is rejected (read-only)", async () => {
    const queue = track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const writable = queue.whenWritable();
    await connectAs(provider(), "viewer", fetchMock);
    expect(await settled(writable)).toBe("rejected");
  });

  it("whenWritable is rejected when the note is deleted, the tab is outdated, or the holder releases", async () => {
    const first = track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const deleted = first.whenWritable();
    act(() => provider(0).emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_NOTE_DELETED } }));
    expect(await settled(deleted)).toBe("rejected");
    first.release();

    const second = track(acquireNoteConnection(NOTE_ID, queueHolder()));
    await act(async () => {
      fetchMock.mockResolvedValue(tokenOk("editor"));
      await provider(1).configuration.token();
    });
    const outdated = second.whenWritable();
    act(() => provider(1).emit("authenticationFailed", { reason: COLLAB_REJECT_CLIENT_OUTDATED }));
    expect(await settled(outdated)).toBe("rejected");
    second.release();

    const third = acquireNoteConnection(NOTE_ID, queueHolder());
    const released = third.whenWritable();
    third.release();
    expect(await settled(released)).toBe("rejected");
  });

  it("revoked while only the queue holds: rejected, and no onUnauthorized (the token request succeeded with role none)", async () => {
    const onUnauthorized = vi.fn();
    const queue = track(acquireNoteConnection(NOTE_ID, queueHolder(onUnauthorized)));
    const p = provider();
    await connectAs(p, "editor", fetchMock);
    const writable = queue.whenWritable();

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    fetchMock.mockResolvedValue(tokenOk("none"));
    await act(async () => {
      await p.configuration.token();
    });

    expect(queue.getState().phase).toBe("kicked");
    expect(await settled(writable)).toBe("rejected");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("revoked while only the queue holds and the token request 401s: the queue's onUnauthorized runs", async () => {
    const onUnauthorized = vi.fn();
    track(acquireNoteConnection(NOTE_ID, queueHolder(onUnauthorized)));
    const p = provider();
    await connectAs(p, "editor", fetchMock);

    act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
    act(() => p.emit("close", { event: { code: 1006, reason: "" } }));
    fetchMock.mockResolvedValue(apiFail(401, "unauthorized"));
    await act(async () => {
      await expect(p.configuration.token()).rejects.toThrow();
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("a 401 reaches every holder", async () => {
    const onEditor = vi.fn();
    const onQueue = vi.fn();
    track(acquireNoteConnection(NOTE_ID, queueHolder(onQueue)));
    track(acquireNoteConnection(NOTE_ID, editorHolder(onEditor)));
    fetchMock.mockResolvedValue(apiFail(401, "unauthorized"));
    await act(async () => {
      await expect(provider().configuration.token()).rejects.toThrow();
    });
    expect(onEditor).toHaveBeenCalledTimes(1);
    expect(onQueue).toHaveBeenCalledTimes(1);
  });

  it("a 401 that arrives after the last release still reaches the holder that released last", async () => {
    const onUnauthorized = vi.fn();
    let respond!: (res: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (respond = resolve)));
    const editor = acquireNoteConnection(NOTE_ID, editorHolder(onUnauthorized));
    const token = expect(provider().configuration.token()).rejects.toThrow();
    editor.release();
    expect(provider().destroy).toHaveBeenCalledTimes(1);
    await act(async () => {
      respond(apiFail(401, "unauthorized"));
      await token;
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("released within the reconnect fallback window after a REVOKED close: no connect on the destroyed provider", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const editor = acquireNoteConnection(NOTE_ID, editorHolder());
      const p = provider();
      await connectAs(p, "editor", fetchMock);
      act(() => p.emit("close", { event: { code: 1000, reason: COLLAB_CLOSE_REVOKED } }));
      expect(editor.getState().phase).toBe("reconnecting-once");
      editor.release();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(p.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useCollab over a connection the queue holds", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hoisted.instances.length = 0;
    fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.release();
    vi.unstubAllGlobals();
  });

  it("StrictMode mount, unmount, mount with the queue holding: one provider, never destroyed", () => {
    const queue = track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const { result, unmount } = renderHook(() => useCollab({ noteId: NOTE_ID, onUnauthorized: () => {} }), { wrapper: StrictMode });
    expect(hoisted.instances).toHaveLength(1);
    expect(provider().destroy).not.toHaveBeenCalled();
    expect(result.current.doc).toBe(queue.doc);
    unmount();
    expect(provider().destroy).not.toHaveBeenCalled();
    queue.release();
    expect(provider().destroy).toHaveBeenCalledTimes(1);
  });

  it("the editor re-acquiring a connection the queue kept gets the same doc, synced from its first render with the doc", async () => {
    track(acquireNoteConnection(NOTE_ID, queueHolder()));
    const first = renderHook(() => useCollab({ noteId: NOTE_ID, onUnauthorized: () => {} }));
    const p = provider();
    await connectAs(p, "editor", fetchMock);
    sync(p);
    const doc = first.result.current.doc;
    first.unmount();

    const renders: { doc: Y.Doc | null; synced: boolean; syncedFor: string | null; phase: string }[] = [];
    const second = renderHook(() => {
      const r = useCollab({ noteId: NOTE_ID, onUnauthorized: () => {} });
      renders.push({ doc: r.doc, synced: r.synced, syncedFor: r.syncedFor, phase: r.state.phase });
      return r;
    });
    expect(hoisted.instances).toHaveLength(1);
    expect(second.result.current.doc).toBe(doc);
    const withDoc = renders.filter((r) => r.doc !== null);
    expect(withDoc[0]).toEqual({ doc, synced: true, syncedFor: NOTE_ID, phase: "connected" });
  });

  it("after the editor leaves, a 401 reaches only the queue", async () => {
    const onQueue = vi.fn();
    const onEditor = vi.fn();
    track(acquireNoteConnection(NOTE_ID, queueHolder(onQueue)));
    const view = renderHook(() => useCollab({ noteId: NOTE_ID, onUnauthorized: onEditor }));
    view.unmount();
    fetchMock.mockResolvedValue(apiFail(401, "unauthorized"));
    await act(async () => {
      await expect(provider().configuration.token()).rejects.toThrow();
    });
    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onEditor).not.toHaveBeenCalled();
  });
});
