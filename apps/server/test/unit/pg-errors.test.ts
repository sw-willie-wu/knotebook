import { describe, expect, it } from "vitest";
import {
  foreignKeyViolationConstraint,
  isFolderSpaceViolation,
  isLockTimeout,
  isNoteFolderSpaceViolation,
  isRetryableTxError,
  notNullViolationColumn,
} from "../../src/db/pg-errors.js";

// 兩種錯誤形狀（node-postgres 原生、drizzle 0.44 的 DrizzleQueryError 把原錯誤放 `.cause`）都要認得。
const wrap = (e: object) => new Error("Failed query", { cause: e });

describe("pg-errors 的配額相關判別", () => {
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

describe("pg-errors 的資料夾 trigger 判別", () => {
  it("isNoteFolderSpaceViolation 認 KF001（原生形與 drizzle 形）", () => {
    expect(isNoteFolderSpaceViolation({ code: "KF001" })).toBe(true);
    expect(isNoteFolderSpaceViolation(Object.assign(new Error(), { cause: { code: "KF001" } }))).toBe(true);
  });

  it("isFolderSpaceViolation 認 KF001／KF002／KF003（兩形）；KF002／KF003 不是 isNoteFolderSpaceViolation", () => {
    for (const code of ["KF001", "KF002", "KF003"]) {
      expect(isFolderSpaceViolation({ code }), code).toBe(true);
      expect(isFolderSpaceViolation(Object.assign(new Error(), { cause: { code } })), `wrapped ${code}`).toBe(true);
    }
    for (const code of ["KF002", "KF003"]) {
      expect(isNoteFolderSpaceViolation({ code }), code).toBe(false);
      expect(isNoteFolderSpaceViolation(Object.assign(new Error(), { cause: { code } })), `wrapped ${code}`).toBe(false);
    }
  });

  it("23503 兩者皆假", () => {
    for (const err of [{ code: "23503" }, Object.assign(new Error(), { cause: { code: "23503" } })]) {
      expect(isNoteFolderSpaceViolation(err)).toBe(false);
      expect(isFolderSpaceViolation(err)).toBe(false);
    }
  });
});
