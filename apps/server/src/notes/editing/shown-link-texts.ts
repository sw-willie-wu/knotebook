/**
 * #387：沒有自訂文字的 wikilink（顯示目標的現行標題）在 `edit_note`／`create_note`／REST 寫入時不得被凍結成自訂文字。
 *
 * 讀出（`readNoteContent`：MCP `read_note_section`、REST `GET /content`、`/edits` 與撤回 409 的 `current`）把這種連結匯出成
 * `[目標當時的標題](/notes/<id>)`；寫入時 markdown → wikilink 的規則（`wikilinkPropsFromLink`）只認「文字＝目標**現在的**標題（或網址）」
 * 才不存 label。目標在讀出後改名、agent 照讀到的文字寫回 → 舊標題被存成 label，之後目標再改名也不跟著變。批次寫回（#385，
 * `transfer/link-texts.ts`）把下載時的文字存在基底段表；`edit_note` 沒有基底，所以改在**伺服器記憶體**裡記：
 *
 * - 讀出時記下讀者看到的每個「沒有自訂文字」的連結的 `(讀者, 目標 id, 顯示文字)`（顯示文字＝`wikilinkVisibleText`，與匯出同一個算法）；
 *   同一次讀出裡**有**自訂文字的連結，把同一組 `(讀者, 目標, 文字)` 拿掉（最後讀到的算數；同一次讀出兩種都有時，沒有自訂文字的算數，同 #385）。
 * - 寫入時（`parseMarkdownForNote` 之後）parse 出帶 label 的 wikilink，若 `(寫入者, 目標, label)` 在表裡 → 清掉 label（`keepLabelFree`）。
 *   寫入成功後，寫下去的連結也記在寫入者名下（agent 自己 append 的連結、目標改名後用回覆的指紋原樣寫回，同樣不凍結）。
 * - 讀出（`exportMarkdown`）與 `edit_note`（`prepareEdit`）在持有 editor lease 時只收集、放掉 lease（寫入還要等合併成功）之後才記；
 *   帶 content 建立（`createWithContent`）的解析與收集本來就在 lease 之外，建立成功後才記（m-c）。
 * - 寫入記下的除了存下的連結（沒有自訂文字的以 `snapshotTitle` 記），還有被 `keepLabelFree` 清掉的那些原本的文字。
 * - 只存雜湊（sha256），不存標題原文。每筆保存 `SHOWN_LINK_TTL_MS`（再讀到或寫到會重算）；每帳號至多
 *   `SHOWN_LINK_PER_USER_MAX` 筆（滿了只丟該帳號自己最舊的）、全站至多 `SHOWN_LINK_MAX` 筆（滿了丟全站最舊的）。
 * - process-local（同寫入佇列、presence）：伺服器重啟後表是空的，寫入照舊規則（記在 docs/known-limitations.md）。
 */
import { createHash } from "node:crypto";
import { mapInlineArrays, wikilinkVisibleText, type WikilinkProps } from "@knotebook/shared";
import { keepLabelFree } from "../../transfer/link-texts.js";

export const SHOWN_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const SHOWN_LINK_MAX = 100_000;
export const SHOWN_LINK_PER_USER_MAX = 10_000;

/** 一次讀出裡看到的連結：`[小寫目標 id, 顯示文字]`。`free`＝沒有自訂文字；`custom`＝有。 */
export interface ShownLinks {
  free: Array<[string, string]>;
  custom: Array<[string, string]>;
}

/**
 * `blocks`（含子 block、表格格子）裡的每個 wikilink，依有沒有自訂文字分兩列。不改寫輸入。寫入端記「自己寫下的」時
 * `titles` 給空表：沒有自訂文字的連結就以存下的 `snapshotTitle`（＝寫入的文字，或 `keepLabelFree` 換上的現行標題）記。
 */
export function shownLinkTextsOf(blocks: readonly unknown[], titles: ReadonlyMap<string, string>): ShownLinks {
  const out: ShownLinks = { free: [], custom: [] };
  mapInlineArrays([...blocks], inline => {
    for (const node of inline) {
      const n = node as { type?: unknown; props?: Partial<WikilinkProps> };
      if (n?.type !== "wikilink") continue;
      const props = n.props ?? {};
      const id = String(props.targetNoteId ?? "").toLowerCase();
      if (typeof props.label === "string" && props.label !== "") out.custom.push([id, props.label]);
      else out.free.push([id, wikilinkVisibleText(props, titles.get(id))]);
    }
    return inline;
  });
  return out;
}

const keyOf = (userId: string, targetId: string, text: string): string =>
  createHash("sha256").update(`${userId}\0${targetId.toLowerCase()}\0${text}`).digest("base64url");

export class ShownLinkTexts {
  /** 鍵 → 到期時間與使用者。插入順序＝到期順序（保存期限固定、重記時先刪再插）。 */
  private readonly entries = new Map<string, { exp: number; user: string }>();
  /** 每位使用者的鍵（插入順序＝該使用者的新舊順序），給每帳號上限逐出用（一個帳號不得洗掉別人的記錄）。 */
  private readonly byUser = new Map<string, Set<string>>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly perUserMax: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; max?: number; perUserMax?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? SHOWN_LINK_TTL_MS;
    this.max = opts.max ?? SHOWN_LINK_MAX;
    this.perUserMax = opts.perUserMax ?? SHOWN_LINK_PER_USER_MAX;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  private remove(k: string): void {
    const e = this.entries.get(k);
    if (e === undefined) return;
    this.entries.delete(k);
    const set = this.byUser.get(e.user);
    if (set === undefined) return;
    set.delete(k);
    if (set.size === 0) this.byUser.delete(e.user);
  }

  record(userId: string, shown: ShownLinks): void {
    if (shown.free.length === 0 && shown.custom.length === 0) return;
    const now = this.now();
    for (const [id, text] of shown.custom) this.remove(keyOf(userId, id, text));
    const exp = now + this.ttlMs;
    for (const [id, text] of shown.free) {
      const k = keyOf(userId, id, text);
      this.remove(k);
      this.entries.set(k, { exp, user: userId });
      let set = this.byUser.get(userId);
      if (set === undefined) this.byUser.set(userId, (set = new Set()));
      set.add(k);
    }
    // 每帳號上限：只逐出這個帳號自己最舊的。
    const mine = this.byUser.get(userId);
    while (mine !== undefined && mine.size > this.perUserMax) this.remove(mine.values().next().value!);
    // 全站上限與過期：從最舊的開始丟。
    for (const [k, e] of this.entries) {
      if (e.exp > now && this.entries.size <= this.max) break;
      this.remove(k);
    }
  }

  has(userId: string, targetId: string, text: string): boolean {
    const k = keyOf(userId, targetId, text);
    const e = this.entries.get(k);
    if (e === undefined) return false;
    if (e.exp <= this.now()) {
      this.remove(k);
      return false;
    }
    return true;
  }

  /**
   * 寫入端（parse 之後）：`blocks` 裡帶 label 的 wikilink，`(userId, 目標, label)` 讀到過當作沒有自訂文字的連結 → 清掉 label，
   * `snapshotTitle` 換成目標現在的標題（`candidates`＝寫入者看得到的筆記；同 #385 的 `keepLabelFree`）。回傳新陣列（copy-on-write）
   * 與被清掉的 `(小寫目標 id, 原本的文字)`——寫入端要把它們一起記回去（存下的 `snapshotTitle` 已是現行標題，不記的話原本那段
   * 文字的期限不會因為這次寫入而延長）。
   */
  keepLabelFree<B>(blocks: B[], userId: string, candidates: ReadonlyArray<{ id: string; title: string }>): [B[], Array<[string, string]>] {
    const cleared: Array<[string, string]> = [];
    if (this.entries.size === 0) return [blocks, cleared];
    let titles: Map<string, string> | null = null;
    const titleOf = (id: string): string | undefined => {
      titles ??= new Map(candidates.map(c => [c.id.toLowerCase(), c.title]));
      return titles.get(id.toLowerCase());
    };
    const [out] = keepLabelFree(blocks, (id, text) => this.has(userId, id, text), titleOf, (id, text) => cleared.push([id, text]));
    return [out, cleared];
  }
}
