import { describe, expect, it, vi } from "vitest";
import { openTagEntry, subscribeTagEntry, tagEntryRequestCount, tagEntryReturnFocus } from "./tag-entry";

describe("tag entry requests", () => {
  it("openTagEntry bumps the request count only for that note", () => {
    const a0 = tagEntryRequestCount("note-a");
    const b0 = tagEntryRequestCount("note-b");
    openTagEntry("note-a");
    openTagEntry("note-a");
    expect(tagEntryRequestCount("note-a")).toBe(a0 + 2);
    expect(tagEntryRequestCount("note-b")).toBe(b0);
  });

  it("keeps the latest request's return-focus function, and none when the latest request gave none", () => {
    const back = vi.fn();
    openTagEntry("note-d", { returnFocus: back });
    expect(tagEntryReturnFocus("note-d")).toBe(back);
    expect(tagEntryReturnFocus("note-e")).toBeUndefined();
    openTagEntry("note-d");
    expect(tagEntryReturnFocus("note-d")).toBeUndefined();
  });

  it("tells subscribers on every request and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTagEntry(listener);
    openTagEntry("note-c");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    openTagEntry("note-c");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
