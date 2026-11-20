import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { __resetTagFilterForTests, clearTagFilter, toggleTagFilter, useTagFilter } from "./tag-filter";

afterEach(() => __resetTagFilterForTests());

describe("tag filter store", () => {
  it("myNotes toggles ids on and off; clear empties it; switching tabs keeps it", () => {
    const { result } = renderHook(() => useTagFilter());
    act(() => toggleTagFilter("myNotes", "t1"));
    act(() => toggleTagFilter("myNotes", "t2"));
    expect(result.current.myNotes).toEqual(["t1", "t2"]);
    act(() => toggleTagFilter("myNotes", "t1"));
    expect(result.current.myNotes).toEqual(["t2"]);
    // The store has no notion of "current tab": a clear on the other tab leaves this one alone.
    act(() => clearTagFilter("workspace"));
    expect(result.current.myNotes).toEqual(["t2"]);
    act(() => clearTagFilter("myNotes"));
    expect(result.current.myNotes).toEqual([]);
  });

  it("workspace: a tag from another group replaces the selection and the group", () => {
    const { result } = renderHook(() => useTagFilter());
    act(() => toggleTagFilter("workspace", "a1", "gA"));
    act(() => toggleTagFilter("workspace", "a2", "gA"));
    expect(result.current.workspace).toEqual({ groupId: "gA", tagIds: ["a1", "a2"] });
    act(() => toggleTagFilter("workspace", "b1", "gB"));
    expect(result.current.workspace).toEqual({ groupId: "gB", tagIds: ["b1"] });
    act(() => toggleTagFilter("workspace", "b1", "gB"));
    expect(result.current.workspace).toBeNull();
  });
});
