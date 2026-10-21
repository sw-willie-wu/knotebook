import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { LastEditedDto, NoteDto } from "@knotebook/shared";
import { OWNER_PERMS } from "@/test/fixtures";
import { patchNotesListLastEdited } from "./notes";

function note(id: string, lastEdited: LastEditedDto | null): NoteDto {
  return {
    id,
    title: `T-${id}`,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `s-${id}`,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited,
    group: null,
    groupId: null,
    permissions: OWNER_PERMS,
  };
}

const OLD: LastEditedDto = { at: "2026-10-01T00:00:00.000Z", byHandle: "ann", agentLabel: null };
const NEW: LastEditedDto = { at: "2026-10-03T00:00:00.000Z", byHandle: "bob", agentLabel: "claude" };

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("patchNotesListLastEdited（spec §5.2）", () => {
  it("PL1 沒有 [\"notes\"] 快取：不建立快取項", () => {
    const qc = client();
    patchNotesListLastEdited(qc, "a", NEW);
    expect(qc.getQueryData(["notes"])).toBeUndefined();
    expect(qc.getQueryCache().find({ queryKey: ["notes"] })).toBeUndefined();
  });

  it("PL2 清單裡沒有這一列：不寫", () => {
    const qc = client();
    qc.setQueryData(["notes"], [note("a", OLD), note("b", OLD)]);
    const spy = vi.spyOn(qc, "setQueryData");
    patchNotesListLastEdited(qc, "zzz", NEW);
    expect(spy).not.toHaveBeenCalled();
  });

  it("PL3 只換那一列的 lastEdited，其他列物件與順序不變；null 變有值同樣換", () => {
    const qc = client();
    const prev = [note("a", OLD), note("b", OLD), note("c", null)];
    qc.setQueryData(["notes"], prev);
    patchNotesListLastEdited(qc, "b", NEW);
    const next = qc.getQueryData<NoteDto[]>(["notes"])!;
    expect(next.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(next[1]).toEqual({ ...prev[1], lastEdited: NEW });
    // 其他列參照不變由 TanStack 的 structural sharing 保證，不在此斷言。
    expect(next[0]).toEqual(prev[0]);
    expect(next[2]).toEqual(prev[2]);

    patchNotesListLastEdited(qc, "c", NEW);
    expect(qc.getQueryData<NoteDto[]>(["notes"])![2]).toEqual({ ...prev[2], lastEdited: NEW });

    // 同 at、不同 agentLabel 也要寫（相等判斷三欄都比）。
    const relabeled: LastEditedDto = { ...NEW, agentLabel: "other" };
    patchNotesListLastEdited(qc, "c", relabeled);
    expect(qc.getQueryData<NoteDto[]>(["notes"])![2]!.lastEdited).toEqual(relabeled);
  });

  it("PL4 值相等（另一個新物件）或兩者皆 null：不寫", () => {
    const qc = client();
    qc.setQueryData(["notes"], [note("a", OLD), note("c", null)]);
    const spy = vi.spyOn(qc, "setQueryData");
    patchNotesListLastEdited(qc, "a", { ...OLD });
    patchNotesListLastEdited(qc, "c", null);
    expect(spy).not.toHaveBeenCalled();
  });

  it("PL5 較舊的值或 null 不蓋掉清單裡較新的值", () => {
    const qc = client();
    qc.setQueryData(["notes"], [note("a", NEW)]);
    const spy = vi.spyOn(qc, "setQueryData");
    patchNotesListLastEdited(qc, "a", OLD);
    patchNotesListLastEdited(qc, "a", null);
    expect(spy).not.toHaveBeenCalled();
    expect(qc.getQueryData<NoteDto[]>(["notes"])![0]!.lastEdited).toEqual(NEW);
  });
});
