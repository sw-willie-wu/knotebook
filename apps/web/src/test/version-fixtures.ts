/**
 * #272 版本測試的固定 id 與標籤。`vid(seq)`：seq 編進前 4 個 hex（短 id 前 7 碼互異）與最後一組的第 1–8 個 hex（推名的兩個索引）。
 * 例：`vid(1)`＝`0001aaaa-0000-4000-8000-000100010000`、`vlabel(1)`＝`agile-beaver (0001aaa)`、`vlabel(2)`＝`amber-bison (0002aaa)`、
 * `vlabel(3)`＝`ample-bobcat (0003aaa)`。斷言一律經被測的 `versionLabel`（`vlabel`）；每支有 vN 斷言的測試檔另至少寫死一處字面值（spec §12.2）。
 */
import type { VersionBaseRefDto } from "@knotebook/shared";
import type { VersionTarget } from "@/api/versions";
import { versionLabel } from "@/components/versions/version-labels";

export function vid(seq: number): string {
  const h = seq.toString(16).padStart(4, "0");
  return `${h}aaaa-0000-4000-8000-${h}${h}0000`;
}

export function vlabel(seq: number, name: string | null = null): string {
  return versionLabel({ id: vid(seq), name });
}

/** e2e 另有一份同樣的 `reEscape`（`e2e/tests/helpers.ts`；e2e 不能依賴 web 套件），兩處須同步。 */
export function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 列（`<button>`）的可及名稱以標籤開頭（後面接 pill 與第二行）。 */
export function vrow(seq: number, name: string | null = null): RegExp {
  return new RegExp(`^${reEscape(vlabel(seq, name))}`);
}

export function vtarget(seq: number, name: string | null = null): VersionTarget {
  return { seq, id: vid(seq), name };
}

export function baseRef(seq: number, name: string | null = null): VersionBaseRefDto {
  return { id: vid(seq), name, deleted: false };
}

export function baseRefOrNull(baseSeq: number | null | undefined): VersionBaseRefDto | null {
  return baseSeq === undefined || baseSeq === null ? null : baseRef(baseSeq);
}
