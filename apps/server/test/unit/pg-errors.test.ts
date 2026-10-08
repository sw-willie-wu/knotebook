import { describe, expect, it } from "vitest";
import { foreignKeyViolationConstraint, isLockTimeout, isRetryableTxError, notNullViolationColumn } from "../../src/db/pg-errors.js";

// 兩種錯誤形狀（node-postgres 原生、drizzle 0.44 的 DrizzleQueryError 把原錯誤放 `.cause`）都要認得。
const wrap = (e: object) => new Error("Failed query", { cause: e });

describe("pg-errors 的配額相關判別（spec §6.9、§7.1、§4.2）", () => {
  it("isLockTimeout 只認 55P03；isRetryableTxError 認 40001／40P01／55P03", () => {
    expect(isLockTimeout({ code: "55P03" })).toBe(true);
    expect(isLockTimeout(wrap({ code: "55P03" }))).toBe(true);
    expect(isLockTimeout({ code: "40P01" })).toBe(false);
    for (const code of ["40001", "40P01", "55P03"]) {
      expect(isRetryableTxError({ code }), code).toBe(true);
      expect(isRetryableTxError(wrap({ code })), `wrapped ${code}`).toBe(true);
    }
    expect(isRetryableTxError({ code: "23503" })).toBe(false);
    expect(isRetryableTxError(new Error("x"))).toBe(false);
  });

  it("foreignKeyViolationConstraint：23503 回約束名（兩形），其他碼回 null", () => {
    expect(foreignKeyViolationConstraint({ code: "23503", constraint: "users_storage_plan_fk" })).toBe("users_storage_plan_fk");
    expect(foreignKeyViolationConstraint(wrap({ code: "23503", constraint: "groups_storage_plan_fk" }))).toBe("groups_storage_plan_fk");
    expect(foreignKeyViolationConstraint({ code: "23505", constraint: "x" })).toBeNull();
    expect(foreignKeyViolationConstraint({ code: "23503" })).toBeNull();
  });

  it("notNullViolationColumn：23502 回欄名（兩形），其他碼回 null", () => {
    expect(notNullViolationColumn({ code: "23502", column: "storage_plan_id" })).toBe("storage_plan_id");
    expect(notNullViolationColumn(wrap({ code: "23502", column: "storage_plan_id" }))).toBe("storage_plan_id");
    expect(notNullViolationColumn({ code: "23503", column: "storage_plan_id" })).toBeNull();
  });
});
