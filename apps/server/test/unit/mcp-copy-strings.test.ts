/** #180 spec §6.6 U7：COPY_UPLOAD_LIMIT_MESSAGE 的數字由 UPLOAD_LIMIT 內插（不手抄）；copy 配額可見形用 formatBytes。 */
import { describe, expect, it } from "vitest";
import { UPLOAD_LIMIT } from "../../src/http/rate-limit.js";
import { COPY_UPLOAD_LIMIT_MESSAGE, copyQuotaVisibleMessage } from "../../src/mcp/tools/copy-note.js";

describe("U7 copy_note 字串內插", () => {
  it("upload 上限句的數字＝UPLOAD_LIMIT（今天 120 檔／10 分）", () => {
    expect(COPY_UPLOAD_LIMIT_MESSAGE).toContain(`${UPLOAD_LIMIT.limit} files per ${UPLOAD_LIMIT.windowMs / 60_000} minutes`);
    expect(COPY_UPLOAD_LIMIT_MESSAGE).toBe(
      "Copying this note's images would go over your upload limit (120 files per 10 minutes, copies included), so nothing was copied. Wait a few minutes and try again."
    );
  });
  it("可見形全文（formatBytes：2 GiB／1.5 GiB／12 MiB）；個人空間 Your、群組 The group's；incoming 為 null 時省略 they need", () => {
    const G = 2 * 1024 ** 3, used = 1.5 * 1024 ** 3, inc = 12 * 1024 ** 2;
    expect(copyQuotaVisibleMessage({ kind: "group", id: "g" }, used, G, inc)).toBe(
      "The group's storage space has no room for this note's images (1.5 GB of 2 GB used; they need 12 MB), so the note was not copied. " +
        "A site admin can assign a larger storage plan; deleting notes that have images also frees space."
    );
    expect(copyQuotaVisibleMessage({ kind: "user", id: "u" }, used, G, null)).toBe(
      "Your storage space has no room for this note's images (1.5 GB of 2 GB used), so the note was not copied. " +
        "A site admin can assign a larger storage plan; deleting notes that have images also frees space."
    );
  });
});
