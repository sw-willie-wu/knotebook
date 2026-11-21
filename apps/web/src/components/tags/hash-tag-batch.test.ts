import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddNoteTagResultDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ApiFail } from "@/api/client";
import { dismissAllToasts, type ToastItem } from "@/components/ui/toast";
import { notifyHashTagOverLimit, runHashTagBatch, type HashTagBatchDeps } from "./hash-tag-batch";

const toasts: Array<Omit<ToastItem, "id">> = [];
vi.mock("@/components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/toast")>()),
  toast: (item: Omit<ToastItem, "id">) => void toasts.push(item),
}));

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { lng: "en", ...opts }) as string;

function deps(overrides: Partial<HashTagBatchDeps> = {}): HashTagBatchDeps & { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  return {
    noteId: "n1",
    currentNames: () => [],
    add: async (name) => {
      added.push(name);
      return { tags: [], tag: { id: `id-${name}`, name, color: "blue" }, attached: true } satisfies AddNoteTagResultDto;
    },
    remove: async (id) => void removed.push(id),
    t,
    ...overrides,
    added,
    removed,
  };
}

beforeEach(() => {
  toasts.length = 0;
  dismissAllToasts();
});

describe("runHashTagBatch", () => {
  it("adds each name and shows 'Tags added: a, b' with an Undo action", async () => {
    const d = deps();
    await runHashTagBatch(d, { names: ["a", "b"], restore: () => true });
    expect(d.added).toEqual(["a", "b"]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toBe("Tags added: a, b");
    expect(toasts[0]!.action?.label).toBe("Undo");
    expect(toasts[0]!.action?.altText).toBe("Undo adding a, b");
  });

  it("does not add names already on the note, case-insensitively, and shows no toast when nothing is new", async () => {
    const d = deps({ currentNames: () => ["Alpha"] });
    await runHashTagBatch(d, { names: ["alpha"], restore: () => true });
    expect(d.added).toEqual([]);
    expect(toasts).toEqual([]);

    const d2 = deps({ currentNames: () => ["Alpha"] });
    await runHashTagBatch(d2, { names: ["ALPHA", "beta"], restore: () => true });
    expect(d2.added).toEqual(["beta"]);
    expect(toasts[0]!.title).toBe("Tags added: beta");
  });

  it("Undo removes only the newly attached tags, then restores the text", async () => {
    const d = deps({ currentNames: () => ["old"] });
    const restore = vi.fn(() => true);
    await runHashTagBatch(d, { names: ["old", "fresh"], restore });
    toasts[0]!.action!.onClick();
    await vi.waitFor(() => expect(restore).toHaveBeenCalled());
    expect(d.removed).toEqual(["id-fresh"]);
  });

  it("Undo and the failure rollback leave alone a tag the server says the note already had", async () => {
    const stale = (d: ReturnType<typeof deps>) => {
      const add = d.add;
      d.add = async (name) => (name === "theirs" ? { tags: [], tag: { id: "id-theirs", name, color: "blue" }, attached: false } : add(name));
    };

    const d = deps();
    stale(d);
    await runHashTagBatch(d, { names: ["theirs", "mine"], restore: () => true });
    toasts[0]!.action!.onClick();
    await vi.waitFor(() => expect(d.removed).toEqual(["id-mine"]));

    toasts.length = 0;
    const failing = deps();
    stale(failing);
    const add = failing.add;
    failing.add = async (name) => {
      if (name === "boom") throw new ApiFail(409, "tag_limit_reached", "x");
      return add(name);
    };
    await runHashTagBatch(failing, { names: ["theirs", "mine", "boom"], restore: () => true });
    expect(failing.removed).toEqual(["id-mine"]);
  });

  it("shows no toast when every name was already on the note on the server", async () => {
    const d = deps({ add: async (name) => ({ tags: [], tag: { id: name, name, color: "blue" }, attached: false }) });
    await runHashTagBatch(d, { names: ["a"], restore: () => true });
    expect(toasts).toEqual([]);
  });

  it("Undo runs once: a second click does nothing", async () => {
    const d = deps();
    const restore = vi.fn(() => true);
    await runHashTagBatch(d, { names: ["a"], restore });
    toasts[0]!.action!.onClick();
    toasts[0]!.action!.onClick();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    expect(d.removed).toEqual(["id-a"]);
  });

  it("removes what this batch attached, restores the text and shows the error when a name fails midway", async () => {
    const d = deps();
    const add = d.add;
    d.add = async (name) => {
      if (name === "b") throw new ApiFail(409, "tag_limit_reached", "x");
      return add(name);
    };
    const restore = vi.fn(() => true);
    await runHashTagBatch(d, { names: ["a", "b"], restore });
    expect(d.removed).toEqual(["id-a"]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(toasts[0]!.title).toBe("Couldn't add the tags. The text was put back.");
    expect(toasts[0]!.variant).toBe("destructive");
    expect(toasts[0]!.description).toBe(t("errors.tag_limit_reached"));
  });

  it("says so when the text could not be put back after a failure", async () => {
    const d = deps({
      add: async () => {
        throw new TypeError("network");
      },
    });
    await runHashTagBatch(d, { names: ["a"], restore: () => false });
    expect(toasts[0]!.title).toBe("Couldn't add the tag.");
  });

  it("says the tags were removed but the text was not put back when Undo cannot restore the text", async () => {
    const d = deps();
    await runHashTagBatch(d, { names: ["a"], restore: () => false });
    toasts[0]!.action!.onClick();
    await vi.waitFor(() => expect(toasts).toHaveLength(2));
    expect(d.removed).toEqual(["id-a"]);
    expect(toasts[1]!.title).toBe("The tags were removed, but the text could not be put back.");
  });

  it("asks to remove the tags by hand when Undo itself fails to remove them", async () => {
    const d = deps({
      remove: async () => {
        throw new TypeError("network");
      },
    });
    await runHashTagBatch(d, { names: ["a"], restore: () => true });
    toasts[0]!.action!.onClick();
    await vi.waitFor(() => expect(toasts).toHaveLength(2));
    expect(toasts[1]!.title).toBe("Couldn't undo everything. Remove the tags from the row above the text.");
  });

  it("runs two batches on the same note one after the other, in trigger order", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const d = deps({
      add: async (name) => {
        order.push(`start ${name}`);
        if (name === "a") await gate;
        order.push(`end ${name}`);
        return { tags: [], tag: { id: name, name, color: "blue" }, attached: true };
      },
    });
    const first = runHashTagBatch(d, { names: ["a"], restore: () => true });
    const second = runHashTagBatch(d, { names: ["b"], restore: () => true });
    await Promise.resolve();
    expect(order).toEqual(["start a"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("reads the note's tags when a queued batch starts, so a name added by the earlier batch is not added twice", async () => {
    const names: string[] = [];
    const d = deps({ currentNames: () => names });
    d.add = async (name) => {
      names.push(name);
      return { tags: [], tag: { id: name, name, color: "blue" }, attached: true };
    };
    await Promise.all([runHashTagBatch(d, { names: ["a"], restore: () => true }), runHashTagBatch(d, { names: ["a"], restore: () => true })]);
    expect(names).toEqual(["a"]);
  });
});

describe("notifyHashTagOverLimit", () => {
  it("names the limit", () => {
    notifyHashTagOverLimit(t, 50);
    expect(toasts[0]!.title).toBe("A note can have at most 50 tags, so the line was left as it is.");
  });
});
