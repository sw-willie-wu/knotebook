/**
 * Hocuspocus v4 的 Fastify 掛載與連線索引。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Plan 2 spike 結論（對 `@hocuspocus/server` 4.5.0 原始碼與實測 harness 定案）
 * ──────────────────────────────────────────────────────────────────────────
 *
 * **1. 掛載機制：原生 `app.server.on("upgrade")` + `ws` 的 `noServer` 模式，自行篩
 * `/collab`；不用 `@fastify/websocket`、也不用 crossws。**
 *
 * v4 內建的 `Server` 類別（`@hocuspocus/server` 的 `Server.ts`）自己 `createServer()`
 * 一台 http server，再用 `crossws/adapters/node` 接 upgrade——那條路等於「Hocuspocus
 * 自帶 HTTP server」，與本專案「單一 Fastify process 同時服務 REST + /collab + SPA」
 * 的架構衝突，故不使用 `Server`，只用底層的 `Hocuspocus` 類別。
 *
 * `Hocuspocus` 對外只要求兩件事（`handleConnection(incoming, request)`）：
 *   - `incoming`：符合 `WebSocketLike`（只需 `send`/`close`/`readyState` 三個成員）
 *     ——`ws` 的 `WebSocket` 原生符合，不必經 crossws 轉接。
 *   - `request`：**web-standard `Request`**（v4 相對 v3 的主要破壞性變更；v3 收的是
 *     Node 的 `IncomingMessage`）。Node 的 upgrade 事件給的是 `IncomingMessage`，所以
 *     這裡用 `toWebRequest()` 手動轉一次（URL + Headers 即可——Hocuspocus 只讀
 *     `request.headers` 與 `getParameters(request)` 的 query string，不讀 body）。
 *
 * 回傳的 `ClientConnection` 需要我們自己把 socket 事件接上：`ws.on("message")` →
 * `handleMessage(Uint8Array)`、`ws.on("close")` → `handleClose({code, reason})`。
 * crossws 幫的就是這一段，對 `ws` 而言只是三行，不值得為它多一個直接依賴。
 *
 * 選擇原生 upgrade 而非 `@fastify/websocket` 的理由：/collab 完全不需要 Fastify 的
 * 路由/序列化/hook 管線（授權走 Hocuspocus 自己的 `onAuthenticate` + collab token，
 * 不走 session cookie 的 `authenticate` preHandler），而且 upgrade 不進 Fastify 路由
 * 也讓 Task 10 的 SPA fallback（`setNotFoundHandler`）不必特別排除 `/collab`。
 *
 * ⚠ 代價：一旦註冊了 `upgrade` listener，Node 就不再自動銷毀未被處理的 upgrade
 * socket，所以非 `/collab` 的 upgrade 必須由我們自己回 404 並 `destroy()`，否則連線
 * 會懸著不放。另外 Fastify 的 `app.close()` 不會關掉已 upgrade 的 socket——關機序
 * 必須 `await collab.destroy()` 在 `app.close()` **之前**（見 `destroy()`）。
 *
 * **2. document name（= noteId）走「WebSocket 訊息內容」，不走 URL。**
 *
 * `HocuspocusProvider` 連的是固定的 `configuration.url`（本專案即 `ws://host/collab`），
 * 文件名不在 path 也不在 query：每則訊息的第一個 varString 就是 rawKey
 * （`documentName`，或啟用 sessionAwareness 時的 `documentName\0sessionId`），由
 * `ClientConnection.handleMessage` 解出來後才進 `onAuthenticate`（payload 帶
 * `documentName`）。實測：兩個 provider 連同一個 `ws://…/collab`、`name` 給同一個
 * note uuid，即在同一份文件上收斂。
 *
 * 推論（Task 5 必須依賴的性質）：**同一條 WebSocket 可承載多份文件**，因此
 * `socketId` 是 per-websocket 而非 per-document——連線索引與 onNextTokenSync 的回呼
 * 一律以 `(socketId, documentName)` 複合鍵登記，不可只用 socketId。
 *
 * **3. 各 hook payload 的實測形狀（Task 5/6 直接依賴，勿憑記憶改）：**
 *   - `onAuthenticate`：有 `token`/`documentName`/`connectionConfig`，**無 `connection`**
 *     （連線期 readOnly 只能經 `connectionConfig.readOnly` 設定）；回傳值會被 merge 進
 *     該連線的 `context`。
 *   - `connected`：**有 `connection`**（含 `socketId`/`context`/`readOnly`）。
 *   - `onDisconnect`：**無 `connection`**，有 `socketId` + `documentName`。⚠ 正因為沒有
 *     `connection`，這個 hook **不足以**驅動索引拆除：一條 socket 可承載多份文件，
 *     client 退訂又重訂同一篇筆記時（`provider.detach()` 會送 CLOSE 訊息，SPA 在筆記間
 *     導覽即是此形狀），先後兩次登記共用同一個 `(socketId, documentName)` 複合鍵，此 hook
 *     無從分辨自己代表哪一次。本檔改用 `Connection.onClose`（有物件同一性）拆索引。
 *   - `onTokenSync`：有 `connection` + `socketId` + `documentName` + 新的 `token`；
 *     由 server 端 `connection.requestToken()` 觸發，provider 收到後會重新呼叫它的
 *     token function 並回送（實測往返成立，Task 6 的 5s deadline 即建立在此之上）。
 *   - `Connection.close({code, reason})` 只切斷「該連線對該文件」的關係並送一則帶
 *     reason 的應用層 CLOSE 訊息給那一個 client，不影響同文件的其他連線、也不關閉底層
 *     socket——正是撤權需要的粒度（有別於 `closeConnections()` 的 ResetConnection 廣播）。
 */
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { Hocuspocus, type WebSocketLike } from "@hocuspocus/server";
import { WebSocketServer, type RawData, type WebSocket as WsWebSocket } from "ws";
import {
  COLLAB_CLOSE_NOTE_DELETED,
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_INVALID_TOKEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_REJECT_SERVER_ERROR,
} from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { UserGate } from "../auth/session.js";
import { loadNoteAudience, resolveRole } from "../notes/service.js";
import { verifyCollabToken } from "./token.js";
import { createNoteStore, docClock, type StoreLogger } from "./store.js";
import { FixedWindowLimiter } from "../http/rate-limit.js";

/** Hocuspocus 的 `onStoreDocument` debounce（ms）。production 一律 2000——見 Task 7 brief。 */
const STORE_DEBOUNCE_MS = 2_000;

/**
 * CollabServer 需要的 logger 介面。比 `StoreLogger`（只要 `warn`）多兩級：
 * - `debug`／`info`：握手拒絕（issue #37）——正常營運事件，但**必須留下訊號**。
 *   兩級的分法見 `rejectAuth`。
 * - `error`：`onAuthenticate` 撞到未預期例外（DB 抖動…），那是真的故障。
 *
 * pino（`index.ts` 傳進來的 production logger）原生符合。
 */
export interface CollabLogger extends StoreLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

// `CollabDeps.log` 缺席時的退路。比照 hooks-impl.ts 的 `consoleLogger`：不是靜默 no-op
// ——樂觀鎖衝突是「本該是唯一寫入者卻撞到別的東西動過這一列」的異常事件，吞掉會讓問題
// 無跡可循；握手拒絕同理（issue #37）。production 一律走 Fastify logger，這條路只在
// 嵌入式用法／測試 harness 未注入 logger 時生效。
const consoleCollabLogger: CollabLogger = {
  debug: (obj, msg) => console.debug(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  info: (obj, msg) => console.info(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

/** 共編 WebSocket 的掛載路徑。前端 provider 與測試 harness 都以此組 URL。 */
export const COLLAB_PATH = "/collab";

/** 應用層 CLOSE 訊息用的 close code。client 端只讀 reason（provider 一律填 1000）。 */
const APP_CLOSE_CODE = 1000;

// 拒連原因住在 `@knotebook/shared`：client 的 `useCollab` 要拿同一組字串去讀 provider 的
// `authenticationFailed`（issue #6），兩邊各自手抄一份早晚會漂。這裡再匯出一次，舊的
// import 路徑（server 測試）照常可用。
export {
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_INVALID_TOKEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_REJECT_SERVER_ERROR,
};

/**
 * 握手拒絕的**細分原因**（server 端日誌用）→ 送給 client 的 wire reason（issue #35／#37）。
 *
 * 兩層是刻意的：client 只需要知道「這是不是一則授權裁決」（見 `@knotebook/shared` 那組
 * 常數的註解），把 `bad-token` 與 `session-revoked` 分開對它毫無意義、反而是多一組要維護
 * 的相容面；但維護者在事後查「這個人為什麼連不上」時，這兩者要的處置天差地遠（前者是
 * token 本身的問題，後者是這個 session 已被撤銷）。細分留在日誌裡，wire 維持三個值。
 *
 * 每個 cause 的日誌級別不同（見 `rejectAuth`），但**出口只有 `rejectAuth` 一個**：
 * 別處裸 `throw new CollabAuthError(...)` 的話，那次拒連就不會出現在 `cause` 這個欄位上，
 * 而 docs 的排錯指引正是叫維護者 grep 它（審查抓到——`server-error` 一度就是這樣漏掉的，
 * 而它偏偏是唯一會讓分頁真的一直停在「連線中」的那個）。
 */
const REJECT_WIRE_REASON = {
  /** 這篇筆記正在刪除中，或剛被刪掉不久（`markDeleting` 閘門，見 `DELETING_GATE_TTL_MS`）。 */
  "note-deleting": COLLAB_REJECT_NOTE_DELETING,
  /** token 缺席／簽章不符／過期／綁的 noteId 不是這一篇。**唯一在驗證 token 之前就會發生的**。 */
  "bad-token": COLLAB_REJECT_INVALID_TOKEN,
  /** `gate.check` 不通過：帳號停用、或 token 的 tokenVersion 已被 bump。 */
  "session-revoked": COLLAB_REJECT_INVALID_TOKEN,
  /** token 有效，但這個人對這篇筆記沒有任何角色——唯一真正的「授權被拒」。 */
  "no-role": COLLAB_REJECT_FORBIDDEN,
  /** onAuthenticate 撞到未預期例外（DB 抖動…）。不是裁決，client 會自己退避重試。 */
  "server-error": COLLAB_REJECT_SERVER_ERROR,
} as const;

export type CollabRejectCause = keyof typeof REJECT_WIRE_REASON;

/**
 * `onAuthenticate` 拒連時要 throw 的錯誤。
 *
 * - `reason` 會被 Hocuspocus 寫進送給 client 的 permission-denied 訊息，client 端從
 *   `onAuthenticationFailed({ reason })` 收到——這是唯一會傳到對端的資訊。
 * - `message` 刻意留空：Hocuspocus 的 hook 執行器對「有 message 的錯誤」會無條件
 *   `console.error` 出來（繞過 Fastify logger）。拒連是正常的營運事件（撤權、刪除中、
 *   過期 token），不該每次都往 stderr 噴一行未結構化的錯誤並汙染測試輸出。
 *   ⚠ 因此**訊號只能靠 `rejectAuth` 那行結構化 log**（issue #37）——一律經它丟，不要
 *   在別處裸 `throw new CollabAuthError(...)`，否則那次拒連在兩端都不留任何痕跡。
 */
export class CollabAuthError extends Error {
  constructor(readonly reason: string) {
    super("");
  }
}

/**
 * 拒連日誌的 per-user 上限（issue #37 的訊號 vs. 日誌量的折衷，審查 round 2 指出）。
 *
 * 為什麼需要：Hocuspocus 對認證失敗**不關 socket**，還會把該文件的狀態清乾淨，讓同一條
 * socket 上的下一則 auth 訊息當成全新的第一次嘗試。而 collab-token 的 60/分鐘節流管的是
 * 「簽發」不是「使用」——一份合法 token 可以在 120 秒內被同一條 socket 重放無數次。若每
 * 一則都寫一行 info，任何一個帳號都能以近乎線速把自架者的日誌磁碟灌爆（`resolveRole` 對
 * 非 UUID 的 documentName 連 DB 都不查，每一輪的成本近乎於零）。
 *
 * 10/分鐘對診斷綽綽有餘：一次真的撤權只會產生一兩行。
 */
const REJECT_LOG_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/** 「日誌被節流了」這件事本身也只說一次，否則它就是下一個放大器。 */
const SUPPRESSION_NOTICE_LIMIT = { limit: 1, windowMs: 60_000 } as const;

/** 日誌裡 noteId 欄位的長度上限：documentName 由 client 指定，最長可達 512 bytes。 */
const LOGGED_NOTE_ID_MAX = 64;

/** `destroy()` 等待文件全部 unload（讓 pending store 落地）的上限。 */
const DESTROY_UNLOAD_TIMEOUT_MS = 2_000;

/** 每條連線經 `onAuthenticate` 後掛在 Hocuspocus `context` 上的內容。 */
export interface CollabContext {
  userId: string;
}

export interface CollabDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
  /**
   * Task 7（`collab/store.ts`）樂觀鎖衝突事件與握手拒絕（issue #37）的日誌目的地。
   * `createCollabServer` 在 `buildApp()`（因而 `app.log`）存在之前就要建出來（見
   * `src/index.ts` 的呼叫順序），故不能直接依賴 Fastify logger；未傳時退回 console
   * （見 `consoleCollabLogger`）。
   */
  log?: CollabLogger;
}

export interface ConnectionHandle {
  /** Hocuspocus 的 socketId；per-websocket，與 noteId 合組複合鍵才唯一識別一條「文件連線」。 */
  socketId: string;
  noteId: string;
  userId: string;
  /** 要求 client 重送目前的 token（fire-and-forget，無內建 timeout）。 */
  requestToken(): void;
  /** 以指定 reason 關閉「這一條」連線（非 `closeConnections` 的全文件廣播）。 */
  close(reason: string): void;
  setReadOnly(v: boolean): void;
}

export interface CollabServer {
  hocuspocus: Hocuspocus<CollabContext>;
  /** 把 `/collab` 的 WebSocket upgrade 掛到 Fastify 的底層 http server 上。只能呼叫一次。 */
  attach(app: FastifyInstance): void;
  connectionsOf(userId: string): ReadonlySet<ConnectionHandle>;
  connectionsOfNote(noteId: string): ReadonlySet<ConnectionHandle>;
  /**
   * wikilink 索引器同步點：`userId` 必須在該文件上有一條開啟中的連線才回傳目前的
   * `docClock`（`ok: false` 涵蓋兩種情況——文件根本不在記憶體裡，或該使用者沒有任何一條
   * 已登記的連線在這篇筆記上），否則回 `{ ok: false }`。
   */
  linkSyncState(noteId: string, userId: string): { ok: true; clock: number } | { ok: false };
  /**
   * 一次性回呼：該連線下一次 `onTokenSync` 抵達即觸發（Task 6 的 deadline 解除用）。
   *
   * 以 `(socketId, documentName)` 複合鍵存 **Set<cb>** 而非單一 cb——同一條連線在 5s
   * 內可能被 reverify 兩次（例如先撤分享、再停用同一使用者），用覆寫的話第一個
   * timer 永遠等不到解除，會誤殺一條其實已經重驗成功的連線。token 抵達時整組觸發並清空。
   */
  onNextTokenSync(handle: ConnectionHandle, cb: () => void): void;
  /**
   * 刪除閘門：登記期間這篇筆記的連線一律被拒／被關（Task 6 的 beforeNoteDeleted 用）。
   *
   * ⚠ **必須在刪除交易之前 await**：它會先把「此刻看得到這篇筆記的人」抓下來留著
   * （`loadNoteAudience`），交易一 commit 那些列就查不到了。這份名單決定 `onAuthenticate`
   * 要不要對某個人說出 `note-deleting`——名單上的人、以及此刻仍查得到角色的人聽得到，
   * 其他人一律照 `no-role` 回答，閘門因此不會變成「這個 noteId 存不存在」的 oracle
   * （issue #35 審查）。
   *
   * ⚠ 名單抓取失敗時 value 是 `null`，**那絕不等於「誰都聽得到」**（審查 round 3：那樣一次
   * DB 抖動就會把「這個 id 剛被刪掉」告訴每個登入使用者兩分鐘）——`null` 的情況一律退回用
   * 「現在還有沒有角色」判斷，見 `onAuthenticate` 的慢路徑。
   *
   * 回傳這道門的世代序號，收門時要原樣帶回（見 `releaseDeletingGate`）。
   */
  markDeleting(noteId: string): Promise<number>;
  /**
   * 刪除失敗時收閘門，**但只收得掉 `epoch` 所指的那一道、而且只在筆記其實還在的時候**。
   * 回傳有沒有真的收掉。
   *
   * 兩個條件都不可省（審查 round 3／4）：同一篇筆記併發兩個 DELETE 時，失敗那一次不得把
   * 成功那一次開的閘門關掉——關掉的話接下來兩分鐘重連的協作者會聽到「你已失去存取權」，
   * 而真相是筆記真的被刪了。
   */
  releaseDeletingGate(noteId: string, epoch: number): Promise<boolean>;
  unmarkDeleting(noteId: string): void;
  /** 關閉所有 socket、flush 待寫入的文件。**必須在 `app.close()` 之前 await。** */
  destroy(): Promise<void>;
}

// socketId 是 crypto.randomUUID() 產生的 UUID，不可能含 NUL——用它當分隔符可保證複合鍵不歧義。
const KEY_SEPARATOR = "\u0000";

function connectionKey(socketId: string, documentName: string): string {
  return `${socketId}${KEY_SEPARATOR}${documentName}`;
}

function addToIndex(index: Map<string, Set<ConnectionHandle>>, key: string, handle: ConnectionHandle): void {
  const existing = index.get(key);
  if (existing) existing.add(handle);
  else index.set(key, new Set([handle]));
}

function removeFromIndex(index: Map<string, Set<ConnectionHandle>>, key: string, handle: ConnectionHandle): void {
  const existing = index.get(key);
  if (!existing) return;
  existing.delete(handle);
  if (existing.size === 0) index.delete(key);
}

const EMPTY_HANDLES: ReadonlySet<ConnectionHandle> = new Set();

/**
 * Node 的 upgrade 請求（`IncomingMessage`）轉成 Hocuspocus v4 要的 web-standard
 * `Request`。只帶 URL 與 headers：Hocuspocus 對這個物件的用途僅止於 `request.headers`
 * 與從 URL 取 query string，不會讀 body（upgrade 請求本來也沒有 body）。
 */
function toWebRequest(url: URL, headers: IncomingHttpHeaders): Request {
  const webHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const one of value) webHeaders.append(name, one);
    else if (value !== undefined) webHeaders.set(name, value);
  }
  return new Request(url, { headers: webHeaders });
}

/**
 * `ws` 的訊息 payload 轉 `Uint8Array`。刻意做一次複製而非 `new Uint8Array(buf.buffer,
 * …)` 的零複製視圖：`Connection.handleMessage` 會把訊息排進佇列非同步處理，而 Node 的
 * Buffer 來自共用 pool，零複製視圖可能在真正被解碼前就被別的資料覆寫。
 */
function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  return new Uint8Array(Buffer.from(data));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createCollabServer(deps: CollabDeps): CollabServer {
  const handles = new Map<string, ConnectionHandle>();
  const byUser = new Map<string, Set<ConnectionHandle>>();
  const byNote = new Map<string, Set<ConnectionHandle>>();
  const tokenSyncCallbacks = new Map<string, Set<() => void>>();
  /**
   * 刪除閘門。key＝正在刪除／剛刪完的 noteId；value＝刪除當下看得到它的 userId 集合
   * （`null`＝名單抓取失敗）。
   *
   * **擋不擋，看的是「這個人現在有沒有角色」；value 只決定「筆記已刪除」這句話說給誰聽。**
   * 有角色的人一律被擋（`onAuthenticate` 的慢路徑、`connected` 與 `onTokenSync` 的再檢查都
   * 只看 key——走到那兩處的連線都已經通過認證）；沒有角色的人本來就連不上，差別只在他聽到
   * 的是 `note-deleting` 還是 `no-role`，而那正是不能外洩的那一位元。
   *
   * ⚠ 名單會連同 userId 一起留到 TTL 到期（兩分鐘）。全公司共享的筆記就是一份全公司名單，
   * 但只在記憶體、只在這段期間。
   */
  const deleting = new Map<string, { epoch: number; audience: ReadonlySet<string> | null }>();
  /** 每次 `markDeleting` 的世代序號——`releaseDeletingGate` 只收得掉「自己開的那一道門」。 */
  let deletingEpoch = 0;
  const sockets = new Set<WsWebSocket>();

  let attached = false;
  let destroyPromise: Promise<void> | undefined;

  /**
   * 拆除一次連線登記。**只在該複合鍵目前登記的就是這一個 handle 時才動手**——同一條
   * socket 對同一份文件退訂再重訂時，遲到的舊連線拆除不得把新的、還活著的登記刪掉
   * （那會讓該連線對 connectionsOf/connectionsOfNote 隱形，撤權就漏了他）。
   *
   * 舊 handle 從 byUser/byNote 的移除不會因此漏掉：重複登記時 `connected` 已先對舊
   * handle 呼叫過一次本函式，兩條路徑合起來保證每個 handle 恰好被移除一次。
   */
  function unregister(key: string, handle: ConnectionHandle): void {
    if (handles.get(key) !== handle) return;
    handles.delete(key);
    tokenSyncCallbacks.delete(key);
    removeFromIndex(byUser, handle.userId, handle);
    removeFromIndex(byNote, handle.noteId, handle);
  }

  // Task 7：note_states/note_state_backups 的唯一寫入者。建在 Hocuspocus 設定物件外面
  // （而非 inline lambda 內 new 一份）純粹是可讀性考量，狀態（sv/lastBackupAt 快取）本來
  // 就只需要一份，跟著整個 CollabServer 的生命週期走。
  const log = deps.log ?? consoleCollabLogger;
  const rejectLogLimiter = new FixedWindowLimiter(REJECT_LOG_LIMIT);
  const serverErrorLogLimiter = new FixedWindowLimiter(REJECT_LOG_LIMIT);
  const suppressionNoticeLimiter = new FixedWindowLimiter(SUPPRESSION_NOTICE_LIMIT);

  /**
   * 這個人在不在「刪除當下的可見名單」上。名單抓取失敗（`null`）一律回 false——**那個 fallback
   * 絕不能是「誰都聽得到」**（審查 round 3）：任何登入使用者都能對任意 UUID 簽一份 token，
   * 於是一次 DB 抖動就會把整整兩分鐘的「這個 id 剛被刪掉」告訴全世界。名單抓不到時改由
   * 「他現在還有沒有角色」決定（見 onAuthenticate），那個判準本身不透露任何額外資訊。
   */
  function deletingAudienceHas(noteId: string, userId: string): boolean {
    const audience = deleting.get(noteId)?.audience;
    return audience !== undefined && audience !== null && audience.has(userId);
  }
  const noteStore = createNoteStore({ db: deps.db, log });

  /**
   * 拒連／踢除的結構化日誌（issue #37）。`phase` 分辨「握手當下被拒」（handshake）與
   * 「連線期重驗後被關」（reverify）——後者才是「我好好的怎麼突然被踢出來」最常見的來源。
   *
   * 為什麼一定要 log：issue #6 修好之後，一次拒連的後果從「使用者卡在連線中（會來回報，
   * 維護者可以現場看畫面）」變成「使用者被自動導走」——他只會說「我突然被踢出來了」。
   * 而 `CollabAuthError.message` 是刻意留空的（見該類別註解），連 Hocuspocus 那則
   * console.error 的間接訊號都沒有，等於一個位元都不留。
   *
   * 欄位：`{ phase, noteId, userId, cause, reason }`，另加 `server-error` 那一行的 `err`
   * （唯一可能帶進外部訊息的欄位，例如 DB driver 的 query 文字）。cause／reason 是有限的
   * 常數集合。**不記 token 內容**。⚠ `noteId` 是 client 指定的 documentName（未必是 uuid，
   * 最長可達 `maxParamLength`），一律截短到 `LOGGED_NOTE_ID_MAX` 再寫。
   *
   * 級別分三級（審查指出）：
   *
   * - `bad-token` → **debug**。/collab 的 upgrade 不需要 session，而 Hocuspocus 對認證失敗
   *   **不關 socket**（還會把該文件的狀態清乾淨，讓下一則 auth 訊息當成全新的第一次嘗試）
   *   ——空 token 那條路徑不查 DB、不驗簽章，等於一則 30 bytes 的 WebSocket 訊息換一行日誌，
   *   而且繞過任何反向代理擋得住的 HTTP 節流。它也是診斷價值最低的一個（沒有 userId，而且
   *   client 收到它只會自己退避重試，不會把人踢走）。
   * - `server-error` → **error**，並帶上 `err`（要 stack）。那是真的故障。
   * - 其餘 → **info**。
   *
   * ⚠ **info／error 兩級都套 per-user 節流**（`REJECT_LOG_LIMIT`，審查 round 2 指出）：
   * collab-token 的 60/分鐘管的是「簽發」不是「使用」，同一份合法 token 可以在 TTL 內被
   * 同一條 socket 重放無數次，每一則都寫一行的話，任何一個帳號都能把日誌磁碟灌爆。
   */
  function logReject(
    phase: "handshake" | "reverify",
    cause: CollabRejectCause,
    reason: string,
    ctx: { noteId: string; userId?: string; err?: unknown }
  ): void {
    const line = {
      phase,
      noteId: ctx.noteId.slice(0, LOGGED_NOTE_ID_MAX),
      userId: ctx.userId,
      cause,
      reason,
    };
    if (phase === "handshake" && cause === "bad-token") {
      log.debug(line, "collab 握手被拒");
      return;
    }
    const key = ctx.userId ?? "anonymous";
    const budget = cause === "server-error" ? serverErrorLogLimiter : rejectLogLimiter;
    if (!budget.consume(key)) {
      // 空的 grep 結果不該分不出「什麼都沒發生」與「被節流了」。這一行本身也要有上限。
      if (suppressionNoticeLimiter.consume(key)) {
        log.warn({ userId: ctx.userId }, "collab 拒連日誌已達每分鐘上限，其餘略過");
      }
      return;
    }
    if (cause === "server-error") log.error({ ...line, err: ctx.err }, "collab 握手被拒");
    else log.info(line, phase === "handshake" ? "collab 握手被拒" : "collab 重驗後關閉連線");
  }

  /** 拒絕這次握手：留下日誌（見 `logReject`）再丟出 `CollabAuthError`。 */
  function rejectAuth(cause: CollabRejectCause, ctx: { noteId: string; userId?: string; err?: unknown }): never {
    const reason = REJECT_WIRE_REASON[cause];
    logReject("handshake", cause, reason, ctx);
    throw new CollabAuthError(reason);
  }

  const hocuspocus = new Hocuspocus<CollabContext>({
    // 不印 Hocuspocus 自己的啟動畫面／噪音；本專案的日誌一律走 Fastify logger。
    quiet: true,

    // Task 7：debounce `onStoreDocument`——單次連續編輯只在停手 2s 後落地一次，而不是
    // 每個 keystroke 都寫 DB（`maxDebounce` 留預設 10s，保證持續打字時仍會定期落地）。
    debounce: STORE_DEBOUNCE_MS,

    // `document` 是 Hocuspocus 的 `Document`（`extends Y.Doc`），結構相容於
    // `NoteStore` 兩個方法要的 `Y.Doc` 參數。
    onLoadDocument: async ({ documentName, document }) => noteStore.onLoadDocument(documentName, document),
    onStoreDocument: async ({ documentName, document }) => {
      await noteStore.onStoreDocument(documentName, document);
    },
    // fix round 1 IMPORTANT 2：文件從記憶體卸載時清掉 noteStore 的 sv／lastBackupAt
    // 快取，否則每篇曾經打開過的筆記都會在 process 存活期間永久占一個 Map entry（慢性
    // 洩漏）。安全：下一次 onLoadDocument 會重新以 DB 現況初始化這兩個快取。
    afterUnloadDocument: async ({ documentName }) => {
      noteStore.afterUnloadDocument(documentName);
    },

    // 真授權：驗 token 簽章 → 重跑 resolveRole + gate.check——token 內帶的 role 只是
    // 簽發當下的快照，絕不當作授權依據（N2）。這保證撤分享/停用帳號在 TTL 內對「舊而
    // 未過期」的 token 立即生效，而不必等 token 自然過期。
    onAuthenticate: async ({ token, documentName, connectionConfig }) => {
      // ⚠ 提到 try 外面（審查 round 2）：`server-error` 那一行也要帶得出 userId——它正是
      // 唯一會讓分頁真的一直停在「連線中」的原因，維護者最需要知道是誰。catch 看不到
      // try 內的 `claims`，所以身分一驗出來就先存這裡。
      let userId: string | undefined;
      try {
        const claims = token ? await verifyCollabToken(deps.config.appSecret, token) : null;
        // documentName 是「這條連線實際要連的文件」，claims.noteId 是 token 簽發當下綁定
        // 的文件——兩者不符代表這份 token 被拿去連了別篇筆記（即使簽章本身有效），必須拒絕。
        if (!claims || claims.noteId !== documentName) {
          rejectAuth("bad-token", { noteId: documentName });
        }
        userId = claims.userId;

        // ⚠ 刪除閘門刻意排在**驗完 token 之後**（審查指出）：它是這個 server 唯一會透露
        // 「某個 noteId 存在（且剛被刪掉）」的地方，擺在最前面等於讓一個連 session 都不需要
        // 的 socket 就能問這個問題。擺在這裡，要問就得先持有一份對這篇筆記合法簽章的 token。
        // 順序仍必須早於 resolveRole：刪除交易 commit 之後那一列就查不到了，先跑 role 的話
        // 這條路會落到 `no-role`（＝對使用者說「你已失去存取權」），而真相是筆記被刪了。
        // 只有「刪除當下本來就看得到這篇筆記的人」聽得到 note-deleting；其他人往下走，
        // 最終落在 `no-role`——與「這篇筆記存在但不是你的」完全一樣的可觀察行為。
        // 這一段是快路徑（不查 DB）：名單命中就直接結案，刪除交易已 commit 也仍然答得出來。
        if (deletingAudienceHas(documentName, claims.userId)) {
          rejectAuth("note-deleting", { noteId: documentName, userId: claims.userId });
        }

        const role = await resolveRole(deps.db, claims.userId, documentName);

        // 慢路徑：閘門開著、而且**此刻還查得到角色**⇒ 這個人本來就看得到這篇筆記，可以對他
        // 說 note-deleting。這一段同時補三件事，且都不透露任何「名單以外」的資訊：
        //   - 名單抓取失敗（audience 為 null）時的替代判準；
        //   - 快路徑那次讀取剛好早於 `markDeleting` 的競態（審查 round 2）；
        //   - 刪除窗口內才被加分享的人（名單快照抓不到他）——照樣要擋。
        // 反過來，`role === 'none'` 又不在名單上的人一律往下落到 `no-role`，與「這篇筆記存在
        // 但不是你的」完全同一句話。
        if (deleting.has(documentName) && (role !== "none" || deletingAudienceHas(documentName, claims.userId))) {
          rejectAuth("note-deleting", { noteId: documentName, userId: claims.userId });
        }
        if (role === "none") {
          rejectAuth("no-role", { noteId: documentName, userId: claims.userId });
        }
        const gateResult = await deps.gate.check(claims.userId, claims.tv);
        if (gateResult.status !== "ok") {
          // 帳號停用或 tokenVersion 已被 bump——**不是**「對這篇筆記沒有權限」。client 據此
          // 重取一次 token，那一發會拿到 401（session 也失效了）並走登出流程（issue #35）。
          rejectAuth("session-revoked", { noteId: documentName, userId: claims.userId });
        }

        // ⚠ v4 的 onAuthenticate payload 沒有 `connection` 物件（見檔頭註解）——連線期的
        // 唯讀狀態只能經這裡的 connectionConfig.readOnly 設定；`connection.readOnly` 這個
        // 可變欄位要到 connected/onTokenSync 才拿得到（Task 6 降級走 `setReadOnly`）。
        if (role === "viewer") {
          connectionConfig.readOnly = true;
        }

        return { userId: claims.userId };
      } catch (err) {
        if (err instanceof CollabAuthError) throw err;
        // 未預期例外（`resolveRole`／`gate.check` 撞到 DB 抖動…）。不接的話 Hocuspocus 會
        // 把它翻成字面值 `"permission-denied"` 送出去（見 `ClientConnection` 的 catch），
        // client 舊版一律當撤權——對一個權限完好的使用者說錯話，而且 server 端也不會留下
        // 任何紀錄（`console.error` 只印 message，這裡的 err 才有 stack）。
        //
        // ⚠ 一樣走 `rejectAuth`（審查指出）：這是唯一會讓分頁真的一直停在「連線中」的原因，
        // 也就是維護者最需要找到的那一種。它若不出現在 `cause` 欄位上，docs 教的
        // `grep '"cause"'` 就剛好漏掉它。
        rejectAuth("server-error", { noteId: documentName, userId, err });
      }
    },

    // 索引只在 connected 建立（此時才拿得到 Connection 實例）。
    connected: async ({ connection, socketId, documentName, context }) => {
      // ⚠ 競態窗口：onAuthenticate 通過之後、connected 抵達之前，Hocuspocus 已經在
      // drain 佇列訊息——這條連線在這段期間是「活的」（能 apply update），但要到這裡
      // 才會被登記進索引。若 markDeleting 剛好在這個窗口內被設定（onAuthenticate 當下
      // 還沒 deleting，通過了檢查），這條連線會對 connectionsOfNote 永遠隱形，Task 6
      // 的刪除清掃（枚舉 connectionsOfNote 逐一 close）找不到它，等於刪除中的筆記還能
      // 被寫入。在這裡重查一次並直接關閉，不註冊進索引，堵掉這個窗口。
      if (deleting.has(documentName)) {
        connection.close({ code: APP_CLOSE_CODE, reason: COLLAB_CLOSE_NOTE_DELETED });
        return;
      }

      const key = connectionKey(socketId, documentName);

      // ⚠ 同一個複合鍵可能被重複登記：一條 socket 可承載多份文件，client 退訂某篇筆記
      // （provider.detach() 會送 CLOSE 訊息）之後又在**同一條 socket** 上重新訂閱同一篇
      // （SPA 在筆記間導覽就是這個形狀）。舊登記若不先拆乾淨，它會永遠留在
      // byUser/byNote 裡，讓 connectionsOf 把早已關閉的連線也算進去。
      const stale = handles.get(key);
      if (stale) unregister(key, stale);

      const handle: ConnectionHandle = {
        socketId,
        noteId: documentName,
        userId: context.userId,
        requestToken: () => connection.requestToken(),
        close: (reason: string) => connection.close({ code: APP_CLOSE_CODE, reason }),
        setReadOnly: (v: boolean) => {
          connection.readOnly = v;
        },
      };
      handles.set(key, handle);
      addToIndex(byUser, handle.userId, handle);
      addToIndex(byNote, handle.noteId, handle);

      // 拆除掛在「這一條 Connection 自己」的關閉回呼，而不是全域 onDisconnect hook：
      // onDisconnect 的 payload 只有 socketId + documentName、**沒有 connection**，無從分辨
      // 送達的是哪一次登記的拆除通知。退訂後立刻重訂時，新的 connected 可能早於舊連線的
      // 拆除通知抵達，屆時一個「照複合鍵刪除」的拆除會把**新的、還活著的**連線從索引中
      // 移除——該使用者從此對 connectionsOfNote 隱形，Task 6 的撤權會漏掉他，而他還在編輯。
      // 走 connection.onClose 才有物件同一性可比對（見 unregister 的守衛）。
      connection.onClose(() => unregister(key, handle));

      // 補一次保險：連線有可能在 connected 抵達之前就已經關閉（socket 在排隊訊息 drain
      // 期間斷掉），那樣 Connection.close 的回呼會早於上面這行註冊而跑掉，死連線就會
      // 永遠留在索引裡。
      if (!connection.document.hasConnection(connection)) unregister(key, handle);
    },

    // 重驗：與 onAuthenticate 同一套邏輯（驗簽章 → 重跑 resolveRole + gate.check，
    // token 內 role 不作授權依據）。⚠ 不讀寫 `connection.context`——它是 hookPayload
    // 快照，在 onTokenSync 觸發的當下已經 stale（§5）；「這條連線 onAuthenticate 當時
    // 的 userId」改用我們自己的索引（`handle.userId`）比對，N6 要求新 token 的 userId
    // 必須與它相同，否則視同借殼延續，一律 close。
    //
    // 拒絕走 `handle.close(COLLAB_CLOSE_REVOKED)`，不 throw：這個 hook 一旦 throw，
    // Hocuspocus 會把該連線以 Unauthorized 關掉；throw 出來的錯誤還會被無條件
    // console.error（見 CollabAuthError 的類別註解），撤權是正常營運事件不該噴 stderr。
    //
    // ⚠ onNextTokenSync 的回呼**不論本次重驗結果為何都要觸發**：它只是「這條連線收到一次
    // token sync 了」的訊號（Task 6 拿來解除 5s deadline），驗證失敗一樣是有收到回應。
    // 必須在驗證**之前**先取出＋清空 callbacks、驗證結果用 try/finally 派送——
    // `handle.close()` 會同步觸發 `connection.onClose` → `unregister(key, handle)` →
    // `tokenSyncCallbacks.delete(key)`；若照舊在驗證「之後」才去 `.get(key)`，reject
    // 分支會發現這個 key 早已被 unregister 清掉，callbacks 靜靜地一個都不會觸發
    // （Task 6 的 5s deadline 因此永遠等不到解除）。驗證中途若意外 throw（例如
    // resolveRole/gate.check 撞到 DB 抖動），finally 仍保證 callbacks 被觸發，錯誤本身
    // 照樣往外冒（與 onAuthenticate 對未預期例外的處理一致，不在此吞掉）。
    onTokenSync: async ({ socketId, documentName, token }) => {
      const key = connectionKey(socketId, documentName);
      const callbacks = tokenSyncCallbacks.get(key);
      tokenSyncCallbacks.delete(key);

      try {
        const handle = handles.get(key);
        if (!handle) return;

        // 每條 close 都留下與握手同一組欄位的訊號（`phase: "reverify"`，issue #37 的排錯
        // 指引承諾 grep 得到「我突然被踢出來」——而連線期被撤權走的正是這條路，不是握手）。
        const closeWith = (cause: CollabRejectCause, reason: string): void => {
          logReject("reverify", cause, reason, { noteId: documentName, userId: handle.userId });
          handle.close(reason);
        };

        if (deleting.has(documentName)) {
          closeWith("note-deleting", COLLAB_CLOSE_NOTE_DELETED);
          return;
        }

        const claims = token ? await verifyCollabToken(deps.config.appSecret, token) : null;
        if (!claims || claims.userId !== handle.userId || claims.noteId !== documentName) {
          closeWith("bad-token", COLLAB_CLOSE_REVOKED);
          return;
        }

        const role = await resolveRole(deps.db, claims.userId, documentName);
        if (role === "none") {
          closeWith("no-role", COLLAB_CLOSE_REVOKED);
          return;
        }

        const gateResult = await deps.gate.check(claims.userId, claims.tv);
        if (gateResult.status !== "ok") {
          closeWith("session-revoked", COLLAB_CLOSE_REVOKED);
          return;
        }

        handle.setReadOnly(role === "viewer");
      } finally {
        for (const cb of callbacks ?? []) {
          try {
            cb();
          } catch {
            // 回呼是呼叫方（Task 6 的 clearTimeout）的責任，失敗不得影響連線。
          }
        }
      }
    },
  });

  const wss = new WebSocketServer({ noServer: true });

  function handleUpgrade(app: FastifyInstance, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    // 註冊了 upgrade listener 之後，Node 就不會再自動銷毀「沒人處理」的 upgrade
    // socket——非 /collab 的路徑必須由我們明確回絕並關閉，否則 socket 會一直懸著。
    if (url.pathname !== COLLAB_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, ws => {
      sockets.add(ws);
      const clientConnection = hocuspocus.handleConnection(
        ws as unknown as WebSocketLike,
        toWebRequest(url, request.headers)
      );

      ws.on("message", data => clientConnection.handleMessage(toUint8Array(data)));
      ws.on("close", (code, reason) => {
        sockets.delete(ws);
        clientConnection.handleClose({ code, reason: reason.toString() });
      });
      ws.on("error", error => {
        app.log.warn({ err: error }, "collab websocket 錯誤");
      });
    });
  }

  async function runDestroy(): Promise<void> {
    // 先關 socket：走的是與正常斷線相同的路徑（handleClose → onDisconnect →
    // 最後一條連線離開時 flush 該文件的 pending store），資料才不會遺失。
    for (const ws of sockets) ws.close(1001, "server shutdown");
    wss.close();
    hocuspocus.flushPendingStores();

    const deadline = Date.now() + DESTROY_UNLOAD_TIMEOUT_MS;
    while (hocuspocus.documents.size > 0 && Date.now() < deadline) {
      await sleep(25);
    }

    // 期限內沒乖乖關閉的 socket 直接斷——留著會讓後續的 `app.close()` 掛住。
    for (const ws of sockets) ws.terminate();
    sockets.clear();

    await hocuspocus.hooks("onDestroy", { instance: hocuspocus });

    handles.clear();
    byUser.clear();
    byNote.clear();
    tokenSyncCallbacks.clear();
    deleting.clear();
  }

  return {
    hocuspocus,

    attach(app: FastifyInstance): void {
      if (attached) throw new Error("CollabServer.attach 只能呼叫一次");
      attached = true;
      app.server.on("upgrade", (request, socket, head) => {
        try {
          handleUpgrade(app, request, socket, head);
        } catch (error) {
          // upgrade listener 內的例外沒有 Fastify 錯誤處理接手，逸出會直接讓 process
          // 掛掉（例如來源 header 詭異到 `new Headers()` 拒收）——一律記錄後關掉該 socket。
          app.log.error({ err: error }, "collab upgrade 失敗");
          socket.destroy();
        }
      });
    },

    connectionsOf(userId: string): ReadonlySet<ConnectionHandle> {
      return byUser.get(userId) ?? EMPTY_HANDLES;
    },

    connectionsOfNote(noteId: string): ReadonlySet<ConnectionHandle> {
      return byNote.get(noteId) ?? EMPTY_HANDLES;
    },

    linkSyncState(noteId: string, userId: string): { ok: true; clock: number } | { ok: false } {
      const doc = hocuspocus.documents.get(noteId);
      if (!doc) return { ok: false };
      const hasConnection = [...(byNote.get(noteId) ?? EMPTY_HANDLES)].some(c => c.userId === userId);
      if (!hasConnection) return { ok: false };
      return { ok: true, clock: docClock(doc) };
    },

    onNextTokenSync(handle: ConnectionHandle, cb: () => void): void {
      const key = connectionKey(handle.socketId, handle.noteId);
      const existing = tokenSyncCallbacks.get(key);
      if (existing) existing.add(cb);
      else tokenSyncCallbacks.set(key, new Set([cb]));
    },

    async markDeleting(noteId: string): Promise<number> {
      let audience: ReadonlySet<string> | null = null;
      try {
        audience = await loadNoteAudience(deps.db, noteId);
      } catch (err) {
        // 抓不到名單不能讓刪除流程卡住：閘門本身（擋連線／擋寫入）才是它的主職責，
        // 「已刪除」這句話說給誰聽則退回用「現在還有沒有角色」判斷（見 onAuthenticate）。
        log.warn({ err, noteId }, "collab 刪除閘門取不到可見名單，改用角色判斷");
      }
      // ⚠ **合併而非覆蓋**（審查 round 3）：同一篇筆記的兩個 DELETE 同時進來時，較晚那次的
      // `loadNoteAudience` 可能落在較早那次 commit 之後而查回空集合——直接覆寫的話，原本
      // 該被告知「筆記已刪除」的協作者全部變成聽到「你已失去存取權」。null（名單不明）遇上
      // 一份真名單時取那份名單：它嚴格地知道得更多。
      const existing = deleting.get(noteId)?.audience;
      const merged =
        existing === undefined || existing === null
          ? audience
          : audience === null
            ? existing
            : new Set([...existing, ...audience]);
      const epoch = (deletingEpoch += 1);
      deleting.set(noteId, { epoch, audience: merged });
      return epoch;
    },

    async releaseDeletingGate(noteId: string, epoch: number): Promise<boolean> {
      // ⚠ 只收得掉「自己開的那一道門」（審查 round 4）：同一篇筆記併發兩個 DELETE 時，
      // 失敗那一次不得把成功那一次開的閘門關掉——關掉的話接下來兩分鐘內重連的協作者會被
      // 告知「你已失去存取權」，而真相是筆記真的被刪了。
      if (deleting.get(noteId)?.epoch !== epoch) return false;

      // 而且只有「筆記其實還在」才收：併發的另一次刪除可能已經 commit 了。
      try {
        const audience = await loadNoteAudience(deps.db, noteId);
        if (audience.size === 0) return false;
      } catch (err) {
        // 查不出來時以呼叫端的說法為準（它剛剛才刪失敗）：放行比讓一篇還在的筆記被宣告
        // 「已刪除」兩分鐘好。要走到這裡得同時發生「併發刪除」與「DB 查詢失敗」。
        log.warn({ err, noteId }, "collab 刪除失敗後查不到筆記是否還在，仍收閘門");
      }

      // 上面那次 await 期間可能又有人開了新的門，再確認一次世代。
      if (deleting.get(noteId)?.epoch !== epoch) return false;
      deleting.delete(noteId);
      return true;
    },

    unmarkDeleting(noteId: string): void {
      deleting.delete(noteId);
    },

    async destroy(): Promise<void> {
      // 冪等：關機序可能同時被信號處理與測試 teardown 觸發，第二次呼叫等同一個 in-flight。
      destroyPromise ??= runDestroy();
      return destroyPromise;
    },
  };
}
