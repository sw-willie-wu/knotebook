/** #200 §7.2：upload_id 收裸 UUID 或恰為 /api/uploads/<uuid>，transform 成小寫裸 id；其餘形與 NUL 拒絕。 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UPLOAD_ID } from "../../src/mcp/tools/read-note-image.js";

describe("#200 upload_id schema", () => {
  const id = randomUUID();
  it.each([
    ["裸", id],
    ["前綴", `/api/uploads/${id}`],
    ["大寫", id.toUpperCase()],
    ["前綴＋大寫", `/api/uploads/${id.toUpperCase()}`],
  ])("%s → 通過且 transform 成小寫裸 id", (_l, input) => {
    const r = UPLOAD_ID.safeParse(input);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(id);
  });
  it.each([
    ["尾巴多一段", `/api/uploads/${id}/x`],
    ["絕對網址", `https://example.com/api/uploads/${id}`],
    ["含 NUL", `${id}${String.fromCharCode(0)}`],
    ["空字串", ""],
  ])("%s → 拒絕", (_l, input) => {
    expect(UPLOAD_ID.safeParse(input).success).toBe(false);
  });
});
