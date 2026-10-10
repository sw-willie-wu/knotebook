/**
 * 版本專用指紋（spec 2026-10-09-note-versions-design.md A14）。與 `editing/fingerprint.ts` 的 `outlineOf(...).whole` 分家：
 * 那顆是 #106 `if_match` 的契約（`canonicalizeNode`，**不得改**），這顆只給版本子系統判斷「有沒有改」。四條差別：
 * (1) 空的 `Y.XmlText` 視同不存在——「打一字再刪」留下的 `T[]` 與新建空段落的 `[]` 同值（r1 實跑：兩者在 whole 上不同）；
 * (2) 頂層全部是「屬性全為 schema 預設、無內容」的 paragraph（含零顆、多顆）＝真空（兩人同時打開真空筆記會合併出兩顆空段落，r5）；
 * (3) **不丟例外**：顯式 stack 走訪（`canonicalizeNode` 遞迴，5000 層 RangeError——r3 實跑）、依文件順序直接走訪、不經 id 查表
 *     （缺 id 不撞鍵）、未知節點照 nodeName、屬性值以有深度上限的 `stableValue` 序列化。
 * (4) 屬性值**嚴格等於**（`===`）該元素類型在 shared schema 的 `propSchema[prop].default` 時視同缺席（spec §13-9 方案二）：
 *     舊 schema 寫的筆記缺較新的預設屬性，瀏覽器打一字再刪時 y-prosemirror 會把那個段落連預設屬性一起寫回，內容沒變。
 *     型別不同視為不等（`level: "1"` 不等於預設 `1`）；查不到預設的類型／屬性照舊參與；值為 `undefined` 的屬性一律視同缺席。
 * 雜湊同 `fingerprintOf`（sha256 前 16 hex）；輸入帶 `V2:` 前綴（(4) 之前是 `V1:`），與 whole 的值域分開，不會被誤當 `if_match`。
 * 不做資料遷移：若有 `V1:` 的基底指紋，該篇下一次比對會視為有改，最多多切一版。
 * 只認識 BlockNote 0.52 的結構名（`blockGroup`／`blockContainer`／`paragraph`），升版時 `version-fingerprint.test.ts` 的 pin 案會紅。
 */
import * as Y from "yjs";
import { createHeadlessNoteSchema } from "@knotebook/shared";
import { fingerprintOf } from "./editing/fingerprint.js";

/** BlockNote 0.52.1 `defaultProps` 的預設值（`test/unit/version-fingerprint.test.ts` 釘住）。 */
export const PARAGRAPH_DEFAULT_PROPS: Readonly<Record<string, string>> = {
  backgroundColor: "default",
  textColor: "default",
  textAlignment: "left",
};

export const VACUUM_VERSION_FINGERPRINT = fingerprintOf("V2:vacuum");

/** config 不一定是物件：0.52 的 inline `text`／`link` 在 `inlineContentSchema` 裡就是字串 `"text"`／`"link"`。 */
type SchemaConfigs = Record<string, unknown>;
interface SchemaLike {
  blockSchema?: SchemaConfigs;
  inlineContentSchema?: SchemaConfigs;
  styleSchema?: SchemaConfigs;
}
type WarnFn = (obj: object, msg: string) => void;
// 本模組沒有注入的 logger（模組載入時就要建表）；比照 collab/server.ts 的 consoleCollabLogger。
const consoleWarn: WarnFn = (obj, msg) => console.warn(msg, obj);

/**
 * 從 schema 的 `blockSchema`／`inlineContentSchema`／`styleSchema` 推出 `{ 類型: { 屬性: 預設值 } }`（只收有 `default` 的屬性、
 * 至少一個預設的類型；style 的 propSchema 是 `"boolean"`／`"string"` 字串，沒有預設，不入表）。**不手寫常數表**——會跟 schema 漂移。
 * `load` 丟例外（某環境載不起 shared schema）→ 退回空表並 `warn` 一次：指紋仍算得出來，只是不忽略預設值（永不 throw 的不變量不破）。
 */
export function buildDefaultPropsByType(load: () => SchemaLike, warn: WarnFn = consoleWarn): Record<string, Record<string, unknown>> {
  try {
    const schema = load();
    const table: Record<string, Record<string, unknown>> = {};
    for (const configs of [schema.blockSchema, schema.inlineContentSchema, schema.styleSchema]) {
      for (const [type, config] of Object.entries(configs ?? {})) {
        const propSchema = config !== null && typeof config === "object" ? (config as { propSchema?: unknown }).propSchema : undefined;
        if (propSchema === null || typeof propSchema !== "object") continue;
        const defaults: Record<string, unknown> = {};
        for (const [prop, spec] of Object.entries(propSchema as Record<string, unknown>)) {
          if (spec !== null && typeof spec === "object" && "default" in spec && spec.default !== undefined) defaults[prop] = spec.default;
        }
        if (Object.keys(defaults).length > 0) table[type] = defaults;
      }
    }
    return table;
  } catch (err) {
    warn({ err }, "版本指紋的預設值表建不起來（shared schema 載入失敗），退回空表：值等於預設的屬性照常參與指紋");
    return {};
  }
}

/** 模組載入時建一次（`createHeadlessNoteSchema` 只建 config、不碰 DOM；base 不影響 propSchema）。 */
export const DEFAULT_PROPS_BY_TYPE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = buildDefaultPropsByType(
  () => createHeadlessNoteSchema("http://localhost/"),
);

/** 這個屬性值是否嚴格等於該元素類型在 schema 的預設值（查表一律 `Object.hasOwn`，`constructor` 之類的名字不會撞到原型）。 */
function isSchemaDefault(nodeName: string, attr: string, value: unknown): boolean {
  if (!Object.hasOwn(DEFAULT_PROPS_BY_TYPE, nodeName)) return false;
  const defaults = DEFAULT_PROPS_BY_TYPE[nodeName]!;
  return Object.hasOwn(defaults, attr) && defaults[attr] === value;
}

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
    const kept = Object.keys(attrs)
      // 值為 undefined 一律視同缺席：`numberedListItem.start`、image／video `previewWidth` 的預設就是 undefined（不入表），
      // y-prosemirror 重建節點時會把 undefined 寫進 Yjs。
      .filter(k => k !== "id" && attrs[k] !== undefined && !isSchemaDefault(f.nodeName, k, attrs[k]))
      .sort()
      .map(k => `${JSON.stringify(k)}=${stableValue(attrs[k])}`);
    out.push(`E${JSON.stringify(f.nodeName)}(${kept.join(";")})[`);
    stack.push("]");
    pushChildren(stack, f.toArray());
  }
  return out.join("");
}

/** A14：版本子系統唯一的「內容指紋」。永不丟例外（呼叫端仍包防禦性 catch，§5.3-2）。 */
export function versionFingerprint(fragment: Y.XmlFragment): string {
  return isVacuum(fragment) ? VACUUM_VERSION_FINGERPRINT : fingerprintOf(`V2:${serialize(fragment)}`);
}
