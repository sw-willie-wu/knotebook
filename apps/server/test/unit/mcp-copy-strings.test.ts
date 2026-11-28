/** #180: the limit in copyUploadLimitMessage(limit) is passed by the caller and the window length is interpolated from UPLOAD_LIMIT (not hand-copied); the visible copy quota uses formatBytes. */
import { describe, expect, it } from "vitest";
import { UPLOAD_LIMIT } from "../../src/http/rate-limit.js";
import { copyUploadLimitMessage, copyQuotaVisibleMessage } from "../../src/mcp/tools/copy-note.js";

describe("copy_note string interpolation", () => {
  it("the number in the upload-limit sentence equals the limit passed in (#397: the limiter as read at that moment)", () => {
    expect(copyUploadLimitMessage(12)).toContain("12 files per 10 minutes");
  });
  it("passing UPLOAD_LIMIT.limit -> the full sentence with the default limit (120 files / 10 minutes)", () => {
    expect(copyUploadLimitMessage(UPLOAD_LIMIT.limit)).toBe(
      "Copying this note's files would go over your upload limit (120 files per 10 minutes, copies included), so nothing was copied. Wait a few minutes and try again."
    );
  });
  it("visible form in full (formatBytes: 2 GiB / 1.5 GiB / 12 MiB); personal space says Your, group says The group's; with incoming null, 'they need' is omitted", () => {
    const G = 2 * 1024 ** 3, used = 1.5 * 1024 ** 3, inc = 12 * 1024 ** 2;
    expect(copyQuotaVisibleMessage({ kind: "group", id: "g" }, used, G, inc)).toBe(
      "The group's storage space has no room for this note's files (1.5 GB of 2 GB used; they need 12 MB), so the note was not copied. " +
        "A site admin can assign a larger storage plan; deleting notes that have files also frees space."
    );
    expect(copyQuotaVisibleMessage({ kind: "user", id: "u" }, used, G, null)).toBe(
      "Your storage space has no room for this note's files (1.5 GB of 2 GB used), so the note was not copied. " +
        "A site admin can assign a larger storage plan; deleting notes that have files also frees space."
    );
  });
});
