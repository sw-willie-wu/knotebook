import { describe, expect, it } from "vitest";
import type { KnowledgeInfo } from "@knotebook/shared";
import { draftForSave, draftOf, EMPTY_DRAFT, fieldOfError, singleLine, tooLongLength } from "./form-state";

const INFO: KnowledgeInfo = { id: "k_00000001", when: "w", conclusion: "c", evidence: "docs", verified: "2026-01-01", status: "unverified", supersededBy: "" };

describe("form state", () => {
  it("draftOf drops the id and starts empty for a heading that is not knowledge yet", () => {
    expect(draftOf(INFO)).toEqual({ when: "w", conclusion: "c", evidence: "docs", verified: "2026-01-01", status: "unverified", supersededBy: "" });
    expect(draftOf(null)).toEqual(EMPTY_DRAFT);
  });

  it("singleLine turns every kind of line break into a space without trimming", () => {
    expect(singleLine("a\nb\r\nc\rd")).toBe("a b c d");
  });

  it("a replacement is kept only while the status is outdated", () => {
    const ref = "k_00000002";
    expect(draftForSave({ ...EMPTY_DRAFT, status: "outdated", supersededBy: ref }).supersededBy).toBe(ref);
    expect(draftForSave({ ...EMPTY_DRAFT, status: "unverified", supersededBy: ref }).supersededBy).toBe("");
    expect(draftForSave({ ...EMPTY_DRAFT, status: "", supersededBy: ref }).supersededBy).toBe("");
  });

  it("maps each validation error to the field that shows it", () => {
    expect(fieldOfError("whenTooLong")).toBe("when");
    expect(fieldOfError("conclusionTooLong")).toBe("conclusion");
    expect(fieldOfError("verifiedInvalid")).toBe("verified");
    expect(fieldOfError("supersededSelf")).toBe("supersededBy");
    expect(fieldOfError("empty")).toBe("form");
  });

  it("counts code points and reports a too-long field only after the user edited it", () => {
    const long = { ...EMPTY_DRAFT, when: "x".repeat(201), conclusion: "😀".repeat(300) };
    expect(tooLongLength("when", long, new Set())).toBeNull();
    expect(tooLongLength("when", long, new Set(["when"]))).toEqual({ max: 200, n: 201 });
    expect(tooLongLength("conclusion", long, new Set(["conclusion"]))).toBeNull();
  });
});
