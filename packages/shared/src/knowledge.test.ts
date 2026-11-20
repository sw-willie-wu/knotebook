import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatKnowledgeRef,
  generateKnowledgeId,
  isKnowledgeDate,
  KNOWLEDGE_ID_RE,
  knowledgeIdRenewals,
  knowledgeInfoToProps,
  knowledgePropsPatch,
  knowledgeTextLength,
  normalizeKnowledgeText,
  parseKnowledgeRef,
  readKnowledgeInfo,
  renewKnowledgeId,
  validateKnowledgeDraft,
  type KnowledgeDraft,
  type KnowledgeInfo,
} from "./knowledge.js";

const info = (over: Partial<KnowledgeInfo> = {}): KnowledgeInfo => ({
  id: "k_1234abcd", when: "", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "", ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readKnowledgeInfo", () => {
  it("returns null for an empty id and normalizes unknown evidence and status to empty", () => {
    expect(readKnowledgeInfo(undefined)).toBeNull();
    expect(readKnowledgeInfo({})).toBeNull();
    expect(readKnowledgeInfo({ knowledgeId: "" , knowledgeWhen: "x" })).toBeNull();
    expect(readKnowledgeInfo({ knowledgeId: "k_1234abcd", knowledgeEvidence: "guess", knowledgeStatus: "stale" })).toEqual(info());
    expect(readKnowledgeInfo({ knowledgeId: "k_1234abcd", knowledgeEvidence: "tested", knowledgeStatus: "outdated" })).toEqual(
      info({ evidence: "tested", status: "outdated" }),
    );
  });

  it("treats non-string attributes as empty and never throws", () => {
    expect(readKnowledgeInfo({ knowledgeId: ["k_1"] })).toBeNull();
    expect(readKnowledgeInfo({ knowledgeId: 5 })).toBeNull();
    expect(
      readKnowledgeInfo({
        knowledgeId: "k_1234abcd", knowledgeWhen: 42, knowledgeConclusion: ["a"], knowledgeEvidence: {}, knowledgeStatus: {},
        knowledgeVerified: null, knowledgeSupersededBy: undefined,
      }),
    ).toEqual(info());
  });
});

describe("knowledgePropsPatch", () => {
  it("returns only changed props, and the id plus non-empty props when creating", () => {
    const before = info({ when: "a", evidence: "docs" });
    expect(knowledgePropsPatch(before, { ...before, when: "b" })).toEqual({ knowledgeWhen: "b" });
    expect(knowledgePropsPatch(before, before)).toEqual({});
    expect(knowledgePropsPatch(before, { ...before, evidence: "" })).toEqual({ knowledgeEvidence: "" });
    expect(knowledgePropsPatch(null, info({ conclusion: "c" }))).toEqual({ knowledgeId: "k_1234abcd", knowledgeConclusion: "c" });
    expect(knowledgePropsPatch(null, info())).toEqual({ knowledgeId: "k_1234abcd" });
  });

  it("knowledgeInfoToProps maps every field", () => {
    const all = info({ when: "w", conclusion: "c", evidence: "docs", verified: "2026-01-02", status: "outdated", supersededBy: "k_aaaaaaaa" });
    expect(knowledgeInfoToProps(all)).toEqual({
      knowledgeId: "k_1234abcd", knowledgeWhen: "w", knowledgeConclusion: "c", knowledgeEvidence: "docs",
      knowledgeVerified: "2026-01-02", knowledgeStatus: "outdated", knowledgeSupersededBy: "k_aaaaaaaa",
    });
  });
});

describe("text helpers", () => {
  it("text length counts code points: 200 CJK characters with one emoji is 200", () => {
    expect(knowledgeTextLength("字".repeat(199) + "😀")).toBe(200);
    expect(knowledgeTextLength("")).toBe(0);
  });

  it("normalizeKnowledgeText turns line breaks into spaces and trims", () => {
    expect(normalizeKnowledgeText("  a\r\nb\rc\nd  ")).toBe("a b c d");
  });

  it("isKnowledgeDate accepts only real calendar dates", () => {
    expect(isKnowledgeDate("2026-02-28")).toBe(true);
    expect(isKnowledgeDate("2024-02-29")).toBe(true);
    expect(isKnowledgeDate("2026-02-29")).toBe(false);
    expect(isKnowledgeDate("2026-13-01")).toBe(false);
    expect(isKnowledgeDate("2026-1-1")).toBe(false);
    expect(isKnowledgeDate("0050-01-01")).toBe(true);
    expect(isKnowledgeDate("0000-01-01")).toBe(false);
  });
});

describe("validateKnowledgeDraft", () => {
  const blank: KnowledgeDraft = { when: "", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "" };

  it("reports each rule", () => {
    expect(validateKnowledgeDraft(blank, null, null)).toBe("empty");
    expect(validateKnowledgeDraft({ ...blank, status: "outdated" }, null, null)).toBe("supersededRequired");
    expect(validateKnowledgeDraft({ ...blank, when: "a".repeat(201) }, null, null)).toBe("whenTooLong");
    expect(validateKnowledgeDraft({ ...blank, when: "a".repeat(200) }, null, null)).toBeNull();
    expect(validateKnowledgeDraft({ ...blank, conclusion: "a".repeat(301) }, null, null)).toBe("conclusionTooLong");
    expect(validateKnowledgeDraft({ ...blank, conclusion: "a".repeat(300) }, null, null)).toBeNull();
    expect(validateKnowledgeDraft({ ...blank, verified: "2026-02-30" }, null, null)).toBe("verifiedInvalid");
    expect(
      validateKnowledgeDraft({ ...blank, status: "outdated", supersededBy: "k_1234abcd" }, { noteId: null, knowledgeId: "k_1234abcd" }, null),
    ).toBe("supersededSelf");
    expect(validateKnowledgeDraft({ ...blank, evidence: "docs" }, null, null)).toBeNull();
  });

  it("whitespace-only fields count as empty", () => {
    expect(validateKnowledgeDraft({ ...blank, when: "   ", conclusion: " 	 " }, null, null)).toBe("empty");
    expect(validateKnowledgeDraft({ ...blank, when: " x " }, null, null)).toBeNull();
  });

  it("an outdated draft whose replacement does not parse as a reference is rejected", () => {
    const outdated = (supersededBy: string): KnowledgeDraft => ({ ...blank, status: "outdated", supersededBy });
    expect(validateKnowledgeDraft(outdated("not-a-ref"), null, null)).toBe("supersededInvalid");
    expect(validateKnowledgeDraft(outdated("k_XYZ"), null, null, new Set())).toBe("supersededInvalid");
    expect(validateKnowledgeDraft(outdated("k_00000009"), null, null)).toBeNull();
    expect(validateKnowledgeDraft({ ...blank, evidence: "docs", supersededBy: "garbage" }, null, null)).toBeNull();
  });

  it("a reference to another note's knowledge with the same id is not a self reference", () => {
    const other = "11111111-1111-4111-8111-111111111111";
    const draft: KnowledgeDraft = { ...blank, status: "outdated", supersededBy: `${other}#k_1234abcd` };
    expect(validateKnowledgeDraft(draft, { noteId: null, knowledgeId: "k_1234abcd" }, "22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(validateKnowledgeDraft(draft, { noteId: null, knowledgeId: "k_1234abcd" }, other)).toBe("supersededSelf");
  });

  it("with touched skips length and date checks on untouched fields", () => {
    const draft: KnowledgeDraft = { ...blank, when: "a".repeat(250), conclusion: "ok", verified: "garbage" };
    expect(validateKnowledgeDraft(draft, null, null, new Set(["conclusion"]))).toBeNull();
    expect(validateKnowledgeDraft(draft, null, null, new Set(["when"]))).toBe("whenTooLong");
    expect(validateKnowledgeDraft(draft, null, null, new Set(["verified"]))).toBe("verifiedInvalid");
    expect(validateKnowledgeDraft(draft, null, null)).toBe("whenTooLong");
  });

  it("with touched still applies the empty and superseded rules", () => {
    expect(validateKnowledgeDraft(blank, null, null, new Set())).toBe("empty");
    expect(validateKnowledgeDraft({ ...blank, status: "outdated" }, null, null, new Set())).toBe("supersededRequired");
  });
});

describe("ids", () => {
  it("generateKnowledgeId matches the format and avoids taken ids, also without crypto", () => {
    expect(generateKnowledgeId(new Set())).toMatch(KNOWLEDGE_ID_RE);
    vi.stubGlobal("crypto", {});
    const random = vi.spyOn(Math, "random");
    random.mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    expect(generateKnowledgeId(new Set(["k_00000000"]))).toBe("k_80000000");
    expect(random).toHaveBeenCalledTimes(2);
  });

  it("generateKnowledgeId still terminates when the random source always returns a taken value", () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(generateKnowledgeId(new Set(["k_00000000"]))).toBe("k_00000001");
  });

  it("renewKnowledgeId is deterministic for the same block and old id and skips taken ids", () => {
    const a = renewKnowledgeId("b1", "k_1234abcd", new Set());
    expect(a).toMatch(KNOWLEDGE_ID_RE);
    expect(renewKnowledgeId("b1", "k_1234abcd", new Set())).toBe(a);
    expect(renewKnowledgeId("b2", "k_1234abcd", new Set())).not.toBe(a);
    const b = renewKnowledgeId("b1", "k_1234abcd", new Set([a]));
    expect(b).not.toBe(a);
    expect(b).toMatch(KNOWLEDGE_ID_RE);
  });

  it("knowledgeIdRenewals renews every later duplicate and keeps the first when nothing is marked inserted", () => {
    const r = knowledgeIdRenewals([
      { blockId: "a", knowledgeId: "k_00000001" },
      { blockId: "b", knowledgeId: "k_00000001" },
      { blockId: "c", knowledgeId: "k_00000002" },
      { blockId: "d", knowledgeId: "k_00000001" },
      { blockId: "e", knowledgeId: "" },
    ]);
    expect(r.map((x) => x.blockId)).toEqual(["b", "d"]);
    expect(r.map((x) => x.index)).toEqual([1, 3]);
    const ids = r.map((x) => x.knowledgeId);
    expect(new Set([...ids, "k_00000001", "k_00000002"]).size).toBe(4);
    for (const id of ids) expect(id).toMatch(KNOWLEDGE_ID_RE);
  });

  it("knowledgeIdRenewals renews the inserted copy even when it comes first in the document", () => {
    const dup = (id: string, inserted: boolean) => ({ blockId: id, knowledgeId: "k_00000001", inserted });
    expect(knowledgeIdRenewals([dup("a", true), dup("b", false)]).map((x) => x.blockId)).toEqual(["a"]);
    expect(knowledgeIdRenewals([dup("a", true), dup("b", true)]).map((x) => x.blockId)).toEqual(["b"]);
    expect(knowledgeIdRenewals([dup("a", false), dup("b", true), dup("c", false)]).map((x) => x.blockId)).toEqual(["b", "c"]);
  });

  it("knowledgeIdRenewals reports the index of the item it renews even when block ids repeat", () => {
    const r = knowledgeIdRenewals([
      { blockId: "a", knowledgeId: "k_00000001", inserted: true },
      { blockId: "a", knowledgeId: "k_00000001" },
    ]);
    expect(r.map((x) => x.index)).toEqual([0]);
  });

  it("knowledgeIdRenewals gives the same answer for the same input", () => {
    const items = [{ blockId: "a", knowledgeId: "k_00000001" }, { blockId: "b", knowledgeId: "k_00000001" }];
    expect(knowledgeIdRenewals(items)).toEqual(knowledgeIdRenewals(items));
    expect(knowledgeIdRenewals([{ blockId: "a", knowledgeId: "k_00000001" }])).toEqual([]);
  });
});

describe("knowledge refs", () => {
  it("parseKnowledgeRef and formatKnowledgeRef round-trip same-note and other-note refs", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(parseKnowledgeRef("k_1234abcd")).toEqual({ noteId: null, knowledgeId: "k_1234abcd" });
    expect(parseKnowledgeRef(`${uuid.toUpperCase()}#k_1234abcd`)).toEqual({ noteId: uuid, knowledgeId: "k_1234abcd" });
    for (const bad of ["bad", "x#k_1", "k_XYZ", "", `${uuid}#k_XYZ`, `${uuid}#`]) expect(parseKnowledgeRef(bad)).toBeNull();
    const cur = "22222222-2222-4222-8222-222222222222";
    expect(formatKnowledgeRef({ noteId: cur, knowledgeId: "k_1234abcd" }, cur)).toBe("k_1234abcd");
    expect(formatKnowledgeRef({ noteId: null, knowledgeId: "k_1234abcd" }, cur)).toBe("k_1234abcd");
    expect(formatKnowledgeRef({ noteId: uuid, knowledgeId: "k_1234abcd" }, cur)).toBe(`${uuid}#k_1234abcd`);
    expect(parseKnowledgeRef(formatKnowledgeRef({ noteId: uuid, knowledgeId: "k_1234abcd" }, null))).toEqual({ noteId: uuid, knowledgeId: "k_1234abcd" });
  });
});
