import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { toast } from "@/components/ui/toast";
import i18n from "@/i18n";
import { canEdit, type CollabState } from "./connection";

/** 與 server 端 `notes/service.ts` 的 `UUID_RE` 同一套格式（本檔不 import server 程式碼，
 * 只是同一個 pattern 各自維護一份）——送出前濾掉格式不合法的 `targetNoteId`，不讓壞資料
 * 白跑一趟 `POST /api/notes/:id/links`（server 的 zod `z.string().uuid()` 反正也會拒絕，
 * 這裡只是提早擋、避免無謂的請求/重試迴圈）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Y.Doc 內容變動（含遠端）後，等這麼久沒有新變動才重算＋提交（spec §12.3）。 */
const DEBOUNCE_MS = 2_000;
/** 409 `not_loaded` 的唯一一次重試延遲。 */
const NOT_LOADED_RETRY_MS = 1_000;
/** 5xx（含非 `not_loaded` 的 409，如 `server_busy`）指數退避的起始延遲與上限。 */
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/** `@/api/client` 的 `api()` 最小介面——工廠吃這個型別而非直接 import 該函式本體，
 * 讓測試可以注入 fake fetch/timer 等價物（brief：「純 TS 工廠，fake fetch/timer 可單測」）。 */
export type LinkSyncApiFn = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface CreateLinkSyncOptions {
  noteId: string;
  doc: Y.Doc;
  api: LinkSyncApiFn;
}

export interface LinkSync {
  /** 掛上 `doc` 的 `update` 監聽，開始追蹤內容變動；呼叫端只在 canEdit 時呼叫（見
   * `NotePage.tsx` 的掛載邏輯）。本身不觸發提交——第一次提交一律等 `onSynced()`。 */
  start(): void;
  /** 移除監聽、取消所有排程中的 debounce／重試計時器。冪等。 */
  stop(): void;
  /** 共編連線狀態變動的觀察窗——目前唯一用途是 403 閂的解閂判定（見檔尾說明）。 */
  onCollabState(state: CollabState): void;
  /** provider 的 `synced` 事件（false→true 邊緣，只會是唯一輸入）：重置「上次成功
   * 提交集合」快取並立即重算提交一次，不經過 debounce。 */
  onSynced(): void;
}

/**
 * 走訪 `doc.getXmlFragment(YDOC_FRAGMENT)`，遞迴找出所有 nodeName `"wikilink"` 的
 * `Y.XmlElement`，取其 `targetNoteId` attr（spec §12.3：直讀 Y.Doc，不讀 editor view
 * ——server 端不依賴 BlockNote，這支也一樣不需要掛編輯器就能算出目標集合）。
 *
 * `createTreeWalker` 的 filter 只決定「哪些節點會被 yield」，**不影響是否往下走訪**
 * （walker 對每個節點一律嘗試往下走到它的子節點，filter 沒通過只是跳過該節點本身不
 * yield——見 yjs 原始碼 `YXmlTreeWalker.next()`）：所以就算最外層是不相干的
 * paragraph/blockGroup 節點也一樣會被走訪進去找到巢狀的 wikilink，不需要自己手刻遞迴。
 *
 * 回傳值刻意去重＋排序（穩定的 canonical 集合）：BlockNote 的巢狀結構讓同一個目標可能
 * 因為協作合併等因素在文件裡出現在不同節點，語意上這是同一個「集合」，用穩定形狀
 * 才能跟「上次成功提交集合」做有意義的字串比較（見 `createLinkSync` 內的 unchanged 判定）。
 */
export function extractLinkTargets(doc: Y.Doc): string[] {
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  const found: string[] = [];

  const walker = fragment.createTreeWalker(
    (node): boolean => node instanceof Y.XmlElement && node.nodeName === "wikilink",
  );
  for (const node of walker) {
    if (!(node instanceof Y.XmlElement)) continue; // 型別窄化用；filter 已經在執行期保證了
    const targetNoteId = node.getAttribute("targetNoteId");
    if (typeof targetNoteId === "string" && UUID_RE.test(targetNoteId)) {
      found.push(targetNoteId);
    }
  }

  return [...new Set(found)].sort();
}

/** 三態閂（spec §12.3）：`"none"` 正常運作；`"403"`／`"400"` 各自暫停提交，直到對應的
 * 解閂條件成立（見 `createLinkSync` 內 `onCollabState`／`attemptSubmit` 的判定）。 */
type Latch = "none" | "403" | "400";

/** 失敗重試的排程狀態，繫在觸發它的那個目標集合（`key`）上——集合一旦因為新的
 * debounce／synced 觸發而換掉，舊排程就作廢（見 `attemptSubmit` 開頭的判定）。 */
interface RetryState {
  key: string;
  /** 這個 key 是否已經用掉 409 `not_loaded` 的唯一一次重試機會。 */
  notLoadedUsed: boolean;
  /** 下一次 5xx／其他 409 退避要等的毫秒數（下一次失敗時的延遲，非本次已排程的延遲）。 */
  backoffMs: number;
}

/**
 * wikilink 連結索引提交器（spec §12.3 client 段）——純 TS 狀態機，不碰 DOM／React。
 *
 * 核心流程：`doc` 的 `update` 事件（含遠端）debounce {@link DEBOUNCE_MS} 後重算目標
 * 集合並嘗試提交；`onSynced()`（provider 的 `synced` 事件，唯一輸入）重置「上次成功
 * 提交集合」快取後立即（不 debounce）重算提交一次。所有實際送出都收斂到單一入口
 * `attemptSubmit`，它同時處理「未變不送」「403/400 閂」「跟現有重試排程搭配」三件事，
 * 避免 debounce／synced／重試三條觸發路徑各自維護一份送出邏輯而彼此漂移。
 *
 * 同一時間至多一個 in-flight 請求：`attemptSubmit` 在請求進行中被再次觸發時只記一個
 * `resubmitPending` 旗標，等目前這個請求落地（成功或失敗處理完）才重算一次——不會有
 * 兩個 POST 同時飛在半空中互相競速覆蓋 `lastSubmittedKey`。
 */
export function createLinkSync({ noteId, doc, api }: CreateLinkSyncOptions): LinkSync {
  let started = false;
  let inFlight = false;
  let resubmitPending = false;
  /** 在收到第一次 `onSynced()` 之前，`doc` 上的 `update` 事件可能只是連線握手期間的
   * 初始追平（provider 還在把 server 端既有內容灌進這個 `Y.Doc`，尚未確定「這是完整
   * 同步好的內容」）——這段期間若被 debounce 觸發送出，算出來的 wikilink 集合很可能
   * 只是**尚未追平完成的半吊子集合**（例如缺了還沒同步下來的段落）。`POST .../links`
   * 是**整組取代**語意（body 的 `link_target_ids` 是「該筆記目前內容的完整目標集合」，
   * server 端交易內直接拿它整組覆蓋 `note_links`，不是增量 diff——見
   * `apps/server/src/notes/links.ts` 的 `attemptOnce`／routes 端 JSDoc）：送出這種半吊子
   * 集合不是「晚一點才補齊」，而是會把使用者既有、尚未同步完成而暫時「看不見」的連結
   * 直接刪掉。**最極端的情形**：握手剛開始、`Y.Doc` 幾乎還是空的（追平內容還沒開始
   * applyUpdate 進來）——這時若被 debounce 搶跑，算出來的集合直接是空陣列，等同一次
   * `POST` 就把這篇筆記既有的所有連結**全部清空**，而使用者的編輯內容其實根本沒變。
   * 因此在第一次 `onSynced()` 之前，debounce 觸發的 `attemptSubmit` 一律不送——第一次
   * 提交必須是由 `onSynced()` 本身觸發的那一次（見 brief「synced 後提交一次」；
   * `start()` 本身不觸發提交），確保送出的第一筆一定是同步完成後的完整集合。 */
  let hasSyncedOnce = false;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryState: RetryState | null = null;

  /** `null` 代表「還沒有任何成功提交」或「快取剛被 `onSynced()` 重置」——兩種情況下一次
   * `attemptSubmit` 一律視為「有變動」而送出（`key === null` 恆不等於任何真實 key）。 */
  let lastSubmittedKey: string | null = null;

  let latch: Latch = "none";
  let latch400Key: string | null = null;

  function clearRetryTimer(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(delayMs: number): void {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attemptSubmit();
    }, delayMs);
  }

  /** 409 `not_loaded`／5xx（含非 not_loaded 的 409）／網路失敗的分流處理。403/400 各自
   * 落地成閂，不進這支重試排程。 */
  function handleFailure(err: unknown, key: string): void {
    if (!started) return; // stop() 之後才落地的回應：狀態機已經沒有意義了，不做任何事

    if (err instanceof ApiFail && err.status === 403) {
      latch = "403";
      retryState = null;
      return;
    }

    if (err instanceof ApiFail && err.status === 400) {
      latch = "400";
      latch400Key = key;
      retryState = null;
      toast({
        title: i18n.t(`errors.${err.code}`, { defaultValue: i18n.t("errors.fallback") }),
        variant: "destructive",
      });
      return;
    }

    if (err instanceof ApiFail && err.status === 409 && err.code === "not_loaded") {
      const alreadyUsed = retryState?.key === key && retryState.notLoadedUsed;
      if (alreadyUsed) {
        // 唯一一次重試機會已經用掉：放棄，等下一次真正的觸發（doc 變動／重新 synced）。
        retryState = null;
        return;
      }
      retryState = { key, notLoadedUsed: true, backoffMs: INITIAL_BACKOFF_MS };
      scheduleRetry(NOT_LOADED_RETRY_MS);
      return;
    }

    // 其餘 ApiFail（5xx、非 not_loaded 的 409 如 server_busy）與非 ApiFail（`api()` 對網路
    // 失敗／非 JSON 2xx 丟的原生 Error，見 `useCollab.ts` 的 `isRetryableTokenError` 同款
    // 備忘）一律視為暫時性，走同一套指數退避。
    const previous = retryState?.key === key ? retryState : null;
    const delayMs = previous?.backoffMs ?? INITIAL_BACKOFF_MS;
    retryState = {
      key,
      notLoadedUsed: previous?.notLoadedUsed ?? false,
      backoffMs: Math.min(delayMs * 2, MAX_BACKOFF_MS),
    };
    scheduleRetry(delayMs);
  }

  function send(targets: string[], key: string): void {
    inFlight = true;
    void api<void>(`/api/notes/${encodeURIComponent(noteId)}/links`, {
      method: "POST",
      body: JSON.stringify({ link_target_ids: targets }),
    }).then(
      () => {
        inFlight = false;
        lastSubmittedKey = key;
        retryState = null;
        settleFollowup();
      },
      (err: unknown) => {
        inFlight = false;
        handleFailure(err, key);
        settleFollowup();
      },
    );
  }

  function settleFollowup(): void {
    if (!resubmitPending) return;
    resubmitPending = false;
    attemptSubmit();
  }

  /**
   * 單一送出入口。收斂 debounce／`onSynced`／403 解閂／重試計時器四條觸發路徑的判斷：
   * 1. 未啟動或 403 閂住 → 不送。
   * 2. 400 閂住：重算集合與觸發 400 的集合相同 → 維持閂住；不同 → 解閂並繼續往下判斷。
   * 3. 與「上次成功提交集合」相同 → 不送（未變不送）。
   * 4. 有請求正在飛 → 記 `resubmitPending`，等它落地再重算（不並發送出）。
   * 5. 若目前這個 key 剛好等於某個**排程中**重試 timer 的 key → 讓那個 timer 自己觸發，
   *    不搶著現在送；否則（key 換了）作廢舊排程，改為立即送出這個新集合。
   *
   * 注意第 5 點特別檢查 `retryTimer`（而非只看 `retryState`）：`retryState` 在重試
   * timer 觸發後、下一次失敗判定完成前的這段時間仍然留著同一個 key（`handleFailure`
   * 拿它算下一輪 backoff/notLoadedUsed），若只憑 `retryState.key === key` 判斷，
   * 重試 timer 自己呼叫的這次 `attemptSubmit()`（此時 `retryTimer` 已被設回 `null`，
   * 見 `scheduleRetry`）就會被誤判成「已經有排程在等」而直接 return、實際上永遠不會
   * 真的發出那次重試請求。
   */
  function attemptSubmit(): void {
    if (!started || !hasSyncedOnce || latch === "403") return;

    const targets = extractLinkTargets(doc);
    const key = targets.join(",");

    if (latch === "400") {
      if (key === latch400Key) return;
      latch = "none";
      latch400Key = null;
    }

    if (key === lastSubmittedKey) return;

    if (inFlight) {
      resubmitPending = true;
      return;
    }

    if (retryTimer && retryState?.key === key) return; // 已有同一集合的重試排程中，交給它
    if (retryState && retryState.key !== key) {
      clearRetryTimer();
      retryState = null;
    }

    send(targets, key);
  }

  function onDocUpdate(): void {
    if (!started) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      attemptSubmit();
    }, DEBOUNCE_MS);
  }

  return {
    start() {
      if (started) return;
      started = true;
      doc.on("update", onDocUpdate);
    },

    stop() {
      started = false;
      hasSyncedOnce = false;
      doc.off("update", onDocUpdate);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearRetryTimer();
      retryState = null;
      resubmitPending = false;
    },

    onCollabState(state: CollabState) {
      // 403 閂唯一的解閂路徑：觀察到重新 connected 且角色恢復到 editor+。不看
      // `state`轉移的「邊緣」（例如是否剛好從別的 phase 轉過來）——重複呼叫在
      // `latch !== "403"` 時自然是 no-op，不需要額外的邊緣偵測。
      if (latch === "403" && state.phase === "connected" && canEdit(state.role)) {
        latch = "none";
        attemptSubmit();
      }
    },

    onSynced() {
      if (!started) return;
      hasSyncedOnce = true;
      // 每次 synced（含重連）都要重置快取，讓重算後的集合視為「有變動」而重送一次
      // ——即使跟上次成功提交的內容完全相同（spec：「重連必重送一次」）。
      lastSubmittedKey = null;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearRetryTimer();
      retryState = null;
      attemptSubmit();
    },
  };
}
