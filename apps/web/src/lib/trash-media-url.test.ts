import { describe, expect, it } from "vitest";
import { BLOCKED_MEDIA_URL } from "./media-url";
import { trashMediaUrl } from "./trash-media-url";

describe("trashMediaUrl", () => {
  const resolve = trashMediaUrl("note-123");

  it("maps /api/uploads/<id> to /api/trash/<noteId>/uploads/<id>", () => {
    expect(resolve("/api/uploads/up-456")).toBe("/api/trash/note-123/uploads/up-456");
  });

  it("blocks dangerous URLs via safeMediaUrl before mapping", () => {
    expect(resolve("javascript:alert(1)")).toBe(BLOCKED_MEDIA_URL);
    expect(resolve("data:text/html,<script>alert(1)</script>")).toBe(BLOCKED_MEDIA_URL);
  });

  it("passes through external https URLs and non-matching relative paths", () => {
    expect(resolve("https://example.com/pic.png")).toBe("https://example.com/pic.png");
    expect(resolve("/api/uploads/a/b")).toBe("/api/uploads/a/b");
    expect(resolve("/api/other/123")).toBe("/api/other/123");
  });
});
