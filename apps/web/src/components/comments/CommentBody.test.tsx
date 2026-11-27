import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CommentMentionDto } from "@knotebook/shared";
import { CommentBody, splitBody } from "./CommentBody";

const bob = (start: number, length: number, over: Partial<CommentMentionDto> = {}): CommentMentionDto => ({
  start,
  length,
  userId: "u-bob",
  handle: "bob",
  displayName: "Bob",
  avatar: null,
  agentLabel: null,
  ...over,
});

describe("CommentBody", () => {
  it("offsets are code points: an emoji before the mention doesn't shift it; Chinese around it stays text", () => {
    const body = "😀請@bob看";
    expect(splitBody(body, [bob(2, 4)])).toEqual([
      { kind: "text", text: "😀請" },
      { kind: "mention", text: "@bob", mention: bob(2, 4) },
      { kind: "text", text: "看" },
    ]);
  });

  it("only stored spans become chips; overlapping or out-of-range spans are left as text", () => {
    expect(splitBody("@bob @bob", [bob(5, 4), bob(0, 4), bob(2, 4), bob(8, 9)]).map((s) => s.kind)).toEqual(["mention", "text", "mention"]);
    expect(splitBody("@carol hi", [])).toEqual([{ kind: "text", text: "@carol hi" }]);
  });

  it("a renamed person shows the current name; an agent shows handle (label) in the agent look", () => {
    render(<CommentBody body="@bob and @alice/claude" mentions={[bob(0, 4, { displayName: "Bobby" }), bob(9, 13, { userId: "u-alice", handle: "alice", displayName: "Alice", agentLabel: "claude" })]} />);
    const chips = screen.getAllByTestId("mention-chip");
    expect(chips.map((c) => c.textContent)).toEqual(["@Bobby", "@alice (claude)"]);
    expect(chips[1]).toHaveAttribute("title", "@alice/claude");
    expect(chips[1]!.className).toContain("text-[#7c3aed]");
  });
});
