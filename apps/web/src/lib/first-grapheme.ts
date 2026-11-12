const segmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** 控制、格式（RLO、零寬字元、BOM…）與空白字元：看不見，不能當首字。 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Z}]/gu;
const LEADING_INVISIBLE = /^[\p{Cc}\p{Cf}\p{Z}]+/u;

/** 名字裡有沒有任何看得見的字；全是空白／格式字元時，介面上改用 "?"。 */
export function hasVisibleText(name: string): boolean {
  return name.replace(INVISIBLE, "") !== "";
}

/** 第一個看得見的字素（Intl.Segmenter；不支援時 `[...s][0]`）轉大寫；沒有看得見的字 → "?"。只去掉開頭的不可見字元，ZWJ 合字不受影響。 */
export function firstGrapheme(name: string): string {
  if (!hasVisibleText(name)) return "?";
  const s = name.replace(LEADING_INVISIBLE, "");
  const first = segmenter ? segmenter.segment(s)[Symbol.iterator]().next().value?.segment : [...s][0];
  return (first ?? "?").toUpperCase();
}
