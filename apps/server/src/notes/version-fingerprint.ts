/**
 * 版本專用指紋（spec 2026-10-09-note-versions-design.md A14）。與 `editing/fingerprint.ts` 的 `outlineOf(...).whole` 分家：
 * 那顆是 #106 `if_match` 的契約（`canonicalizeNode`，**不得改**），這顆只給版本子系統判斷「有沒有改」。三條差別：
 * (1) 空的 `Y.XmlText` 視同不存在——「打一字再刪」留下的 `T[]` 與新建空段落的 `[]` 同值（r1 實跑：兩者在 whole 上不同）；
 * (2) 頂層全部是「屬性全為 schema 預設、無內容」的 paragraph（含零顆、多顆）＝真空（兩人同時打開真空筆記會合併出兩顆空段落，r5）；
 * (3) **不丟例外**：顯式 stack 走訪（`canonicalizeNode` 遞迴，5000 層 RangeError——r3 實跑）、依文件順序直接走訪、不經 id 查表
 *     （缺 id 不撞鍵）、未知節點照 nodeName、屬性值以有深度上限的 `stableValue` 序列化。
 * 雜湊同 `fingerprintOf`（sha256 前 16 hex）；輸入帶 `V1:` 前綴，與 whole 的值域分開，不會被誤當 `if_match`。
 * 只認識 BlockNote 0.52 的結構名（`blockGroup`／`blockContainer`／`paragraph`），升版時 `version-fingerprint.test.ts` 的 pin 案會紅。
 */
import * as Y from "yjs";
import { fingerprintOf } from "./editing/fingerprint.js";

/** BlockNote 0.52.1 `defaultProps` 的預設值（`test/unit/version-fingerprint.test.ts` 釘住）。 */
export const PARAGRAPH_DEFAULT_PROPS: Readonly<Record<string, string>> = {
  backgroundColor: "default",
  textColor: "default",
  textAlignment: "left",
};

export const VACUUM_VERSION_FINGERPRINT = fingerprintOf("V1:vacuum");

/** 屬性值巢狀深度上限：超過的部分以 `"…"` 代表（惡意的深巢狀屬性值不得把序列化推進遞迴爆棧）；
 * 超過上限的部分被截成 `"…"`，該部分的差異不反映在指紋上。 */
const VALUE_DEPTH_MAX = 32;

/**
 * 對 JSON 值與 shared `note-sections.ts` 的 `stable()` 同形（鍵排序、陣列保序）；另加三種保險：深度上限、`bigint`／`Uint8Array`
 * 轉字串（`JSON.stringify` 遇 bigint 會丟例外）、`Y.AbstractType` 不展開（有父指標，展開會成環）。
 */
function stableValue(value: unknown, depth = 0): string {
  if (depth > VALUE_DEPTH_MAX) return '"…"';
  if (value === null) return "null";
  if (value instanceof Y.AbstractType) return JSON.stringify(`Y:${value.constructor.name}`);
  if (value instanceof Uint8Array) return JSON.stringify(`bin:${Buffer.from(value).toString("base64")}`);
  if (typeof value === "bigint") return JSON.stringify(`${value.toString()}n`);
  if (Array.isArray(value)) return `[${value.map(v => stableValue(v, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableValue(o[k], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function textToken(t: Y.XmlText): string {
  const delta = t.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
  return `T${stableValue(delta.map(d => ({ insert: d.insert, attributes: d.attributes ?? {} })))}`;
}

function isDefaultEmptyParagraphContainer(node: unknown): boolean {
  if (!(node instanceof Y.XmlElement) || node.nodeName !== "blockContainer") return false;
  if (Object.keys(node.getAttributes()).some(k => k !== "id")) return false;
  if (node.length !== 1) return false;
  const p = node.get(0);
  if (!(p instanceof Y.XmlElement) || p.nodeName !== "paragraph") return false;
  for (const [k, v] of Object.entries(p.getAttributes() as Record<string, unknown>)) {
    if (!Object.hasOwn(PARAGRAPH_DEFAULT_PROPS, k) || PARAGRAPH_DEFAULT_PROPS[k] !== v) return false;
  }
  return p.toArray().every(c => c instanceof Y.XmlText && c.length === 0);
}

/** 真空：fragment 為空，或恰一個 blockGroup、它的每個子節點都是預設空段落（含零個）。只看三層，不遞迴。 */
function isVacuum(fragment: Y.XmlFragment): boolean {
  if (fragment.length === 0) return true;
  if (fragment.length !== 1) return false;
  const group = fragment.get(0);
  return group instanceof Y.XmlElement && group.nodeName === "blockGroup" && group.toArray().every(isDefaultEmptyParagraphContainer);
}

type Frame = Y.XmlElement | Y.XmlText | string;

/** 子節點反序推入（pop 出來就是文件順序）；空 XmlText 與 XmlHook 不進場；兄弟之間推分隔記號。 */
function pushChildren(stack: Frame[], kids: unknown[]): void {
  const kept = kids.filter((c): c is Y.XmlElement | Y.XmlText => c instanceof Y.XmlElement || (c instanceof Y.XmlText && c.length > 0));
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    stack.push(kept[i]!);
    // 兄弟分隔記號是保險、不承重：`E…[…]` 與 `T…` 本身就有明確邊界（gate r1 實跑：拿掉仍 11/11 綠）。
    if (i > 0) stack.push("|");
  }
}

/** 前序序列化，顯式 stack（深度不受 JS 呼叫棧限制）。元素：`E<name>(<排序後的非 id 屬性>)[<子>]`；文字：`T<delta>`。 */
function serialize(fragment: Y.XmlFragment): string {
  const out: string[] = ["F["];
  const stack: Frame[] = ["]"];
  pushChildren(stack, fragment.toArray());
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (typeof f === "string") {
      out.push(f);
      continue;
    }
    if (f instanceof Y.XmlText) {
      out.push(textToken(f));
      continue;
    }
    const attrs = f.getAttributes() as Record<string, unknown>;
    const kept = Object.keys(attrs).filter(k => k !== "id").sort().map(k => `${JSON.stringify(k)}=${stableValue(attrs[k])}`);
    out.push(`E${JSON.stringify(f.nodeName)}(${kept.join(";")})[`);
    stack.push("]");
    pushChildren(stack, f.toArray());
  }
  return out.join("");
}

/** A14：版本子系統唯一的「內容指紋」。永不丟例外（呼叫端仍包防禦性 catch，§5.3-2）。 */
export function versionFingerprint(fragment: Y.XmlFragment): string {
  return isVacuum(fragment) ? VACUUM_VERSION_FINGERPRINT : fingerprintOf(`V1:${serialize(fragment)}`);
}
