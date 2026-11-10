/**
 * 筆記大小上限（`NOTE_MAX_BYTES`，預設 5 MiB；`config.noteMaxBytes` 是唯一的來源，下一版搬進站台設定 #397）。
 *
 * 量的是筆記的 Yjs 狀態（`Y.encodeStateAsUpdate`，＝`note_states.ydoc` 存的位元組）。**依結果判斷，不依更新聲稱的結構**（
 * 從更新的結構推算「新增多少、刪掉多少」是打地鼠——重複的刪除範圍、刪掉的 map key、子文件的 meta／guid、XmlHook 的名稱、ContentAny 裡的
 * BigInt 都能讓推算失準）。一次修改在新文件上試套之後，量四個數（{@link measureTrial}）：
 * - `stateBefore`／`stateAfter`：狀態編碼的長度；
 * - `liveBefore`／`liveAfter`：文件裡所有**還在**的 item 的內容，用 Yjs 自己的編碼器寫出來的位元組數（`item.content.write`，每一種內容都由真的
 *   編碼器涵蓋），加上 map 的 key（屬性名）長度（{@link liveContentBytes}）。型別名稱（XmlElement 的 nodeName、XmlHook 的 hookName）在
 *   ContentType 的編碼裡，屬性是 key 帶值的 item，都已涵蓋。
 *
 * **擋下 iff** `stateAfter > 上限` 且 `stateAfter > stateBefore` 且（`liveAfter > liveBefore` 或 `stateAfter − stateBefore > SLACK`）
 * （{@link capBlocks}）。也就是：
 * - 刪除、改短、等量改寫（還在的內容沒有變多）一律接受——只要狀態沒有一次長超過 {@link SIZE_SLACK_BYTES}；
 * - 還在的內容變多（加字、套格式、設屬性……）而結果超過上限 → 擋；
 * - 還在的內容沒變多、狀態卻一次長了超過 SLACK（例如設一個巨大的 key 再刪掉：key 留在狀態裡）→ 擋。
 *
 * 檢查的是 API／MCP／批次寫回／撤回／套用版本：worker 裡算「基底＋這次寫入」的四個數（`doc-jobs.ts` 的 `measureDiff`／`sizeTrial`），合併前比；
 * 複製是新筆記，比 0。瀏覽器的協作更新**不在 server 檢查**（同 310006f）：網頁編輯器在貼上、拖放、站內 AI 套用之前自己估、自己擋
 * （軟性檢查，`apps/web/src/lib/note-size-guard.ts`）。
 * 已經超過上限的筆記照常開啟、讀出、下載、匯出；不自動截斷、搬移或刪除任何東西。
 */
import * as Y from "yjs";

export const DEFAULT_NOTE_MAX_BYTES = 5 * 1024 * 1024;
/** `NOTE_MAX_BYTES` 的上限（pg `bytea` 單值上限 1 GiB，再大也存不進 `note_states`）。 */
export const NOTE_MAX_BYTES_MAX = 1024 * 1024 * 1024;

/**
 * 還在的內容沒有變多時，一次修改容許狀態長多少（位元組）。4 KiB 的理由：
 * - 正常的刪減與改寫在 Yjs 裡只留很少的簿記：在中間刪一個字狀態約多 1.9 倍更新位元組（幾十 B）、等量改寫約多 43 B、全選一大段再打一個字只多
 *   刪除集的幾個範圍——都遠小於 4 KiB，所以超過上限的筆記照樣能刪、能改短、能小幅改寫；
 * - 只長簿記、不長內容的花招（設一個巨大的 key 再刪掉、灌大量刪除範圍）每則訊息至多長 4 KiB，才有界。
 */
export const SIZE_SLACK_BYTES = 4 * 1024;

/** 修改後超過上限、而且比修改前大（複製這種新筆記用；修改既有筆記用 {@link capBlocks}）。 */
export function growsPastCap(before: number, after: number, cap: number): boolean {
  return after > cap && after > before;
}

/** 試套量到的四個數（見檔頭）。 */
export interface SizeMeasure {
  stateBefore: number;
  stateAfter: number;
  liveBefore: number;
  liveAfter: number;
}

/** 這次修改要不要擋（見檔頭的規則）。 */
export function capBlocks(m: SizeMeasure, cap: number): boolean {
  return m.stateAfter > cap && m.stateAfter > m.stateBefore && (m.liveAfter > m.liveBefore || m.stateAfter - m.stateBefore > SIZE_SLACK_BYTES);
}

/** 這次修改會讓筆記超過大小上限（路由映 413 `note_too_large`、MCP 映工具錯誤 `note_too_large`）。 */
export class NoteTooLargeError extends Error {
  override name = "NoteTooLargeError";
  constructor(
    readonly limitBytes: number,
    readonly sizeBytes: number
  ) {
    super(`note would grow to ${sizeBytes} bytes, over the ${limitBytes}-byte limit`);
  }
}

/** 413 `note_too_large`（REST、批次寫回）與 MCP 工具錯誤共用的訊息。 */
export function noteTooLargeMessage(limitBytes: number): string {
  return `This change would make the note larger than the site's limit of ${limitBytes} bytes, so nothing was written. Deleting and shortening are still accepted; to add more, split the note.`;
}

/** 文件狀態的大小（＝`note_states.ydoc` 的位元組數）。 */
export function stateSize(doc: Y.Doc): number {
  return Y.encodeStateAsUpdate(doc).byteLength;
}

/** 字串的 UTF-8 位元組數（同 Yjs 寫字串時的編碼；不配置記憶體）。 */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
/** 無號變長整數的位元組數（Yjs 的 `writeLen`）。 */
function varUintLength(n: number): number {
  let len = 1;
  while (n > 127) {
    n = Math.floor(n / 128);
    len++;
  }
  return len;
}
/**
 * 文件裡所有還在的 item 的內容，用 Yjs 的編碼器寫出的位元組數，加上 map key 的長度（見檔頭）。成本與整份文件成正比（worker 裡算）。
 * 會被切開的內容（文字、陣列值）不算每顆 item 的長度前綴：在一段文字中間改字會把一顆 item 切成三顆，多出來的前綴不是新增的內容
 * （否則等量改寫會被算成「內容變多」）。文字直接算 UTF-8 長度；陣列值（ContentAny／ContentJSON）寫出後扣掉長度前綴。
 */
export function liveContentBytes(doc: Y.Doc): number {
  const enc = new Y.UpdateEncoderV1();
  let direct = 0;
  for (const structs of doc.store.clients.values()) {
    for (const st of structs) {
      if (!(st instanceof Y.Item) || st.deleted) continue;
      const c = st.content;
      if (c instanceof Y.ContentString) direct += utf8Length(c.str);
      else {
        c.write(enc, 0);
        if (c instanceof Y.ContentAny || c instanceof Y.ContentJSON) direct -= varUintLength(c.getLength());
      }
      if (st.parentSub !== null) direct += utf8Length(st.parentSub);
    }
  }
  return enc.toUint8Array().byteLength + direct;
}

/** 狀態 `state` 套用 `update` 之後的四個數（在新文件上套用；worker 裡跑，`doc-jobs.ts` 的 `sizeTrial`／`measureDiff`）。 */
export function measureTrial(state: Uint8Array, update: Uint8Array): SizeMeasure {
  const doc = new Y.Doc();
  if (state.byteLength > 0) Y.applyUpdate(doc, state);
  const stateBefore = stateSize(doc);
  const liveBefore = liveContentBytes(doc);
  Y.applyUpdate(doc, update);
  return { stateBefore, stateAfter: stateSize(doc), liveBefore, liveAfter: liveContentBytes(doc) };
}
