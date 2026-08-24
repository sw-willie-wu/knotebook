import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  COLLAB_CLOSE_NOTE_DELETED,
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_RESTART_DELAYS_MS,
  COLLAB_RESTART_JITTER,
  type Role,
} from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { collabReducer, INITIAL_COLLAB_STATE, isTerminal, type CollabEvent, type CollabState } from "./connection";

/** `POST /api/notes/:id/collab-token` 的回應形狀（Task 4）。 */
export interface CollabTokenResponse {
  token: string;
  /** 權威角色來源。**絕不解 JWT**——那是 server 與 Hocuspocus 之間的憑證。 */
  role: Role;
}

/**
 * 共編 WebSocket 的 URL。與 REST 一樣走 same-origin（dev 由 Vite proxy 轉去 :3000，
 * 見 `vite.config.ts` 的 `/collab` + `ws: true`；production 由同一個 Fastify process
 * 服務，見 `apps/server/src/collab/server.ts` 的 `COLLAB_PATH`）。
 */
export function collabUrl(location: { protocol: string; host: string } = window.location): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/collab`;
}

/**
 * token function 的**有上限**退避重試表（ms）。5xx／429／網路錯誤走這條——這些都是
 * 「暫時取不到 token」而**不是**授權失敗，不可據此把使用者踢出或登出（spec N7）。
 * 401 例外：那是 session 真的沒了，直接走登出流程、不重試。
 */
const TOKEN_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 進 `reconnecting-once` 後，等自家 close 事件回來的上限；逾時就補一發重連。 */
const RECONNECT_FALLBACK_MS = 1_000;

/**
 * token function 連退避表都跑完仍然失敗、或 server 以「不是授權裁決」的理由拒連之後，
 * **整條連線**要隔多久重來一次（ms，issue #39／#35）。
 *
 * 為什麼需要這一層：`fetchTokenWithRetries` 用完 `TOKEN_RETRY_DELAYS_MS` 就會丟錯，而
 * provider 收到 token function 的錯誤只會 `permissionDeniedHandler`——**socket 不關、也不會
 * 再取一次 token**。server 對 `onAuthenticate` 的 throw 同樣**不關 socket 也不重連**。我們又
 * 刻意不把那一則 `authenticationFailed` 當成撤權（N7／issue #35），於是狀態機收不到任何
 * 事件：畫面停在「連線中」，server 恢復了也不會自己好，只能重整。
 *
 * 間隔比 token 退避表長一個量級：那一輪（7.5 秒）已經證明「不是一時抖動」，再用秒級頻率去
 * 敲一個正在壞的 server 只會加重它的負擔。最後一格重複使用，也就是**永遠會再試**——自我修復
 * 的重點是寧可慢也不要停。
 *
 * ⚠ 上限訂在 60 秒、而且**要抖動**（審查算過）：collab-token 的限流是 **per-user、跨分頁跨筆記
 * 共用一個桶**（60 次/分鐘，見 `routes/notes.ts` 的說明），而每一輪重啟會重跑一次 token 退避表
 * ＝最多 5 發請求。固定間隔 30 秒的話，8 個分頁的穩態就是 64 req/min——**使用者會把自己的額度
 * 永久打爆，server 好了也連不回來**。而且觸發事件（server 重啟）是全分頁同時的，沒有抖動就會
 * 同相位。provider 自己那層 socket 退避預設就開 `jitter: true`，這裡對齊它。
 *
 * ⚠ 數值住在 `@knotebook/shared`：server 端的刪除閘門 TTL 必須蓋得過這裡的最大值，否則
 * 「筆記被刪了」會在重連時被說成「你已失去存取權」（issue #35）。見該常數的說明。
 */
const TOKEN_RESTART_DELAYS_MS = COLLAB_RESTART_DELAYS_MS;

/** 重啟間隔的抖動幅度（±25%）。讓同時壞掉的多個分頁不要同相位重試。 */
const RESTART_JITTER = COLLAB_RESTART_JITTER;

function jittered(delay: number): number {
  return Math.round(delay * (1 + (Math.random() * 2 - 1) * RESTART_JITTER));
}

/**
 * 重啟一條連線：關掉 socket，重連交給 `"close"` 監聽器收到自家 close 時發動（見檔頭
 * 「`disconnect()` 之後不能同步 connect()」）。回傳清理函式（清掉保險絲）。
 *
 * ⚠ **保險絲不清 pending 旗標**（issue #34）：`HocuspocusProviderWebsocket.connect()` 開頭是
 * `if (status === Connected) return`，而那個 early return 發生在 `shouldConnect = true`
 * **之前**。所以保險絲開火時 socket 若還沒真的關掉，那一發 connect() 完全空轉。舊版在那時
 * 順手把旗標清掉，於是稍後真正回來的 close 會被當成一般斷線打回 `connecting`，而 provider
 * 內建的退避又因為 `shouldConnect` 仍是 `false` 不會啟動 ⇒ socket 關了、沒有人重連、永遠
 * 停在「連線中」。
 *
 * 留著旗標的代價：**socket 已開、但認證尚未完成**的那個窗口內（例如 token 還在退避重試的
 * 7.5 秒），第一則底層 close 會被多吞一次——而那一吞緊接著就是一發 connect()，且 `"close"`
 * 監聽器進那個分支就會把旗標清掉，不會變成重連迴圈。認證一成功 `onAuthenticated` 就把旗標
 * 清掉了，所以「保險絲救回連線之後」並不是這個窗口（審查訂正）。
 *
 * ⚠ 病灶只是「清旗標」那一行，**guard 本身要留著**（審查指出，我第一版連 guard 一起拿掉了）：
 * close 準時回來時 swallow 分支已經把旗標清成 false 並發過 connect()，這時保險絲若還照發一發，
 * `HocuspocusProviderWebsocket.connect()` 會 `cancelWebsocketRetry()` 並開一條新的 retry chain、
 * 順手 `cleanupWebSocket()` 掉正在建立中的那條 socket ⇒ **任何耗時超過 1 秒的重連都會被自己的
 * 保險絲拆掉重來**。只讀不清就兩者兼得：close 遲到時旗標仍是 true、保險絲照樣開火；close 準時
 * 時旗標已是 false、保險絲變回 no-op。
 */
function restartConnection(provider: HocuspocusProvider, pendingReconnectRef: { current: boolean }): () => void {
  pendingReconnectRef.current = true;
  provider.disconnect();
  const fallback = setTimeout(() => {
    if (!pendingReconnectRef.current) return;
    void provider.connect();
  }, RECONNECT_FALLBACK_MS);
  return () => clearTimeout(fallback);
}

/**
 * 這個錯誤值不值得重試。`api()` 對網路失敗／非 JSON 2xx 丟的是**原生 Error 而非
 * `ApiFail`**（Task 10 接縫註記③），那類一律視為暫時性；`ApiFail` 則只有 429 與
 * 5xx 可重試。
 */
function isRetryableTokenError(err: unknown): boolean {
  if (err instanceof ApiFail) return err.status === 429 || err.status >= 500;
  return true;
}

export interface UseCollabOptions {
  /** 筆記 uuid（**不是** slug／canonical ref）。`undefined` 代表尚未解析出來，不建連線。 */
  noteId: string | undefined;
  /** 401（session 失效）時的登出流程；由呼叫端注入，這個 hook 不碰 router／query cache。 */
  onUnauthorized: () => void;
}

export interface UseCollabResult {
  state: CollabState;
  /** 連線建立前為 `null`（effect 內才建，StrictMode 才能正確拆）。 */
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  /**
   * 這一條連線的 Y.Doc 是否**曾經**與 server 同步過（issue #48）。
   *
   * sticky：斷線不歸零——同步過一次代表本機文件已載入伺服器內容，之後的離線編輯是
   * 「有東西可以併回」的合法狀態（#39 的重啟會把它們併回去）；換筆記歸零——新連線的
   * Y.Doc 是空的，在第一次 sync 之前那是一篇**空白但看似正常**的筆記，呼叫端要據此
   * 擋掉「在空白筆記上打字、重整就沒了」這個最糟形狀。
   */
  synced: boolean;
}

/**
 * 建立並管理單一筆記的 Hocuspocus 連線，把 provider 的事件翻譯成 `collabReducer`
 * 的事件、再把 reducer 的狀態翻回 provider 的動作（disconnect／connect）。
 *
 * **N7（不可違反，違反即撤權失效）**：這裡**不傳 `websocketProvider`**。provider
 * 沒收到現成的 socket 就會自己建一條（`manageSocket = true`）並自動 `attach()`；
 * 共用一條 socket 會讓 `provider.disconnect()` 變成 no-op，撤權流程整條斷掉。
 * 同理**絕不開 `sessionAwareness`**——server 端的連線索引以
 * `(socketId, documentName)` 為複合鍵，開了之後 documentName 會被塞進 sessionId
 * 而撞名（見 `apps/server/src/collab/server.ts` 檔頭）。
 *
 * 事件對映：
 * - token function 每次取回 body 的 `role` → `token-role` 事件（**權限恢復唯一的
 *   client 訊號**：server 端 `setReadOnly(false)` 不另送通知）。
 * - `onAuthenticated` → `open` 事件，role 取自最近一次 token 回應。
 * - `authenticationFailed`（server 的 permission-denied）→ **依 reason 分兩桶**（issue #35）：
 *   `note-deleting` → `close(NOTE_DELETED)`；`forbidden` → `close(REVOKED)`（沿用二擊語意）；
 *   `invalid-token`／`server-error`／不認得的 reason → **不進狀態機**，排一次連線重啟
 *   （那些拒絕的原因不是權限，見下方 handler 的說明）。
 * - provider 的 `"close"` 事件 → `close` 事件。同一個回呼同時收「應用層 CLOSE 訊息」
 *   （code 硬寫 1000，reason 是 `COLLAB_CLOSE_*`）與「底層 WebSocket close」
 *   （reason 通常空字串），**一律只看 reason**。
 *
 * ⚠ **必須用 `provider.on("close", …)`，不能把 `onClose` 放進 configuration**
 * （瀏覽器實測踩過）：provider 自管 socket 時，它把**同一個 configuration 物件**
 * 交給內部新建的 `HocuspocusProviderWebsocket`，於是 `configuration.onClose` 會被
 * 註冊兩次（一次在 websocket provider 的建構子、一次在 `provider.attach()`），
 * **每一則 socket close 都會呼叫兩次**（應用層 CLOSE 訊息那條路徑則只呼叫一次，
 * 兩者次數還不一致）。用 `provider.on("close")` 只掛在 provider 自己的 emitter 上，
 * 兩條路徑都各自剛好一次。
 *
 * ⚠ **`authenticationFailed` 必須接**（issue #6）：撤權若落在「握手完成之前」的窗口
 * （首次連線還在跑、或重連退避中），server 走的是 `onAuthenticate` throw 而**不是**應用層
 * CLOSE(REVOKED)；Hocuspocus 4.5.0 對這個 throw 只 `writePermissionDenied` 一則訊息，
 * **socket 不關、provider 也不重連**（已對 `ClientConnection` 原始碼核實）。這條路徑上狀態
 * 機收不到任何事件，`token-role: 'none'` 在 `connecting` 又刻意不轉移（角色要等 `open`
 * 才落定）——使用者因此永遠卡在「連線中」、沒有回饋也不會被導走。
 *
 * `forbidden` 翻成 `close(REVOKED)` 而不另開一個終態，是為了**沿用同一套二擊語意**：第一擊進
 * `reconnecting-once`（於是 disconnect → 重取 token 連一次），第二擊（重連拿回的 role 是
 * `'none'`、或再次被拒）才收斂 `kicked`。伺服器一次性抖動（DB 掉拍…）因此不會誤殺
 * 一個合法使用者，而真的撤權一定收斂。`note-deleting` 是例外：筆記已經不在了是定局，
 * 直接走 `deleted`（等同 `close(NOTE_DELETED)`），不浪費一次重連。
 *
 * ⚠ **只有這兩個 reason 算授權裁決**（issue #35）：`invalid-token`（token 驗不過，或 session
 * 的 tokenVersion 已被撤銷＝帳號停用／別處改過密碼）與 `server-error` 都不是「你沒有權限」，
 * 翻成撤權等於對一個權限完好的使用者說錯話並把他導走。那兩桶走的是重啟自我修復，見下方
 * handler。
 *
 * 我方主動 `disconnect()` 造成的 socket close 會被 `pendingReconnectRef` 吞掉一次：
 * 否則進入 `reconnecting-once` 後我們自己關 socket 的那個 close（reason 空字串＝
 * 「其他 reason」）會把狀態打回 `connecting`，白白重置撤權的觀察窗。
 *
 * ⚠ **`disconnect()` 之後不能同步呼叫 `connect()`**（瀏覽器實測踩過，撤權流程整條卡死）：
 * `disconnect()` 只是「要求」關閉（`webSocket.close()`），socket 真正關掉與 status
 * 轉成 `Disconnected` 是**非同步**的；而 `HocuspocusProviderWebsocket.connect()`
 * 開頭就是 `if (this.status === Connected) return`——同步呼叫時 status 還是
 * `Connected`，於是 connect() 直接空轉返回，`shouldConnect` 留在 `false`，內建退避
 * 也不會啟動 ⇒ 那「一次重連」根本沒發生，狀態機永遠等不到第二擊。
 * 正確做法是**等自己那條 close 事件回來再連**：本檔在 `onClose` 吞掉自家 close 的
 * 同一個分支裡才發 `connect()`。那個時間點 `HocuspocusProviderWebsocket` 自己的
 * close 監聽器（建構子裡先註冊，故早於我們的）已經把 `webSocket` 清空、status 設成
 * `Disconnected`，connect() 這時才真的會去建新連線。
 */
export function useCollab({ noteId, onUnauthorized }: UseCollabOptions): UseCollabResult {
  const [state, setState] = useState<CollabState>(INITIAL_COLLAB_STATE);
  const [session, setSession] = useState<{ doc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const [synced, setSynced] = useState(false);

  // provider 建立時就同步寫進 ref：狀態副作用 effect（disconnect/connect）不能等
  // `setSession` 的 re-render 才拿得到 provider。
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const roleRef = useRef<Role>("none");
  /** 「我們自己剛叫了 disconnect()，正在等那條 close 回來好接著重連一次」。 */
  const pendingReconnectRef = useRef(false);
  /** 由連線 effect 填入：把 issue #39 的重啟整條掐掉（終態時呼叫）。 */
  const stopRestartsRef = useRef<(() => void) | null>(null);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  // `collabReducer` 是純函式，StrictMode 重複呼叫 updater 也安全。
  const dispatch = useCallback((event: CollabEvent) => {
    setState((prev) => collabReducer(prev, event));
  }, []);

  useEffect(() => {
    if (!noteId) return;

    // 換筆記＝全新的一場連線；狀態機不得沿用上一篇的（含終態）。
    setState(INITIAL_COLLAB_STATE);
    setSynced(false);
    roleRef.current = "none";
    pendingReconnectRef.current = false;

    let disposed = false;
    /**
     * 「這一條連線最近一次 token function 是以丟錯收場的」。provider 在 `getToken()`
     * 丟錯時會直接呼叫 `permissionDeniedHandler`（見 @hocuspocus/provider 的 `sendToken`），
     * 於是 `authenticationFailed` 也會為我方的 5xx/網路失敗而發——那不是 server 的授權
     * 裁決，不得據此把人踢出（spec N7）。兩者共用同一個事件名，只有我們自己分得出來。
     *
     * ⚠ **它必須是 effect 內的局部變數，不能是 hook 層的 `useRef`**（審查指出）：
     * 舊的那條連線被 `destroy()` 之後，它那一發還在退避中的 token 請求（最長 7.5 秒）
     * 仍會丟錯回來。若旗標是共用的，那一丟會把它設回 `true`，而舊 provider 的
     * `authenticationFailed` 已因 `removeAllListeners()` 無人接收、永遠不會把它清掉；
     * 下一條連線真的被撤權時，那則拒絕就會被這道旗標靜靜吞掉——issue #6 原封不動
     * 回來。每條連線各持一份，這個跨連線的滲漏就不存在。
     */
    let tokenFetchFailed = false;
    /**
     * 「最近一次 token 失敗是終局的」——401（session 沒了，已走登出流程）與 404（筆記不在了，
     * 已收斂 deleted）。這兩種再排重啟只是對一個已經有結論的狀態多打一發 collab-token。
     * 實務上呼叫端緊接著就導頁卸載，但「終態不再重連」這個不變量不該押在呼叫端的行為上
     * （審查指出）。
     */
    let tokenFailureFinal = false;
    /** issue #39 的重啟退避走到第幾格。與 `tokenFetchFailed` 同理由：每條連線各持一份。 */
    let restartAttempt = 0;
    const doc = new Y.Doc();

    const fetchTokenWithRetries = async (): Promise<string> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const body = await api<CollabTokenResponse>(`/api/notes/${encodeURIComponent(noteId)}/collab-token`, {
            method: "POST",
          });
          // ⚠ 成功出口也要 `disposed` 守衛（issue #36）：`roleRef` 與 `dispatch` 都是 hook 層
          // 的（不隨 effect 重建），換筆記後這一發遲到的回應會打進**新筆記**的狀態機。最糟的
          // 組合是新筆記此刻正在 `reconnecting-once`（撤權觀察窗）而遲到的角色是上一篇的
          // `'none'` ⇒ 直接判成第二擊，把使用者踢出一篇他其實有權限的筆記。
          // 仍然回傳 token（不 throw）：這條 promise 的收件人是**舊的** provider，它已被
          // destroy，這個值不會有任何後續；丟錯反而會多走一次 `tokenFetchFailed` 的旗標路徑。
          if (disposed) return body.token;
          roleRef.current = body.role;
          dispatch({ type: "token-role", role: body.role });
          return body.token;
        } catch (err) {
          if (err instanceof ApiFail && err.status === 401) {
            // session 沒了：登出流程，不重試也不當成撤權。
            // 這一支刻意**不加** `disposed` 守衛（有別於下面的 404 與成功出口，issue #36）：
            // 401 是「整個 session 失效」而不是「這一篇筆記的結論」，遲到的那一發同樣代表
            // 使用者已經登出，跳過只會讓他多停留在一個所有請求都會 401 的畫面上。
            tokenFailureFinal = true;
            onUnauthorizedRef.current();
            throw err;
          }
          if (err instanceof ApiFail && err.status === 404) {
            // 保險絲：目前的 server 契約下這條不會發生（token endpoint 對無權限／
            // 已刪除的筆記一律回 200 + role 'none'，見 routes/notes.ts 的說明），
            // 但 spec §5 明訂「重連時 API 404 → deleted」，契約若改動也要正確收斂。
            // 同 issue #36：遲到的 404 屬於**上一篇**筆記，不得把新筆記打成 deleted。
            tokenFailureFinal = true;
            if (!disposed) dispatch({ type: "close", reason: COLLAB_CLOSE_NOTE_DELETED });
            throw err;
          }
          const delay = TOKEN_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !isRetryableTokenError(err) || disposed) throw err;
          await sleep(delay);
        }
      }
    };

    // 交給 provider 的 token function。包這一層只為了記下「這一次取 token 失敗了」，讓
    // `authenticationFailed` 分得出「我方拿不到 token」與「server 拒絕授權」——見
    // `tokenFetchFailed`。每次進場先清旗標：成功的一次不能留下殘影，去吞掉之後真正
    // 的拒絕。
    const fetchToken = async (): Promise<string> => {
      tokenFetchFailed = false;
      tokenFailureFinal = false;
      try {
        return await fetchTokenWithRetries();
      } catch (err) {
        tokenFetchFailed = true;
        throw err;
      }
    };

    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: noteId,
      document: doc,
      token: fetchToken,
      onAuthenticated: () => {
        pendingReconnectRef.current = false;
        // 認證成功＝這條連線活著，issue #39 的重啟退避從頭算起。
        restartAttempt = 0;
        // ⚠ 還排著的那次重啟要一起收掉（審查指出）：拒連在 t=0 排了 5 秒後的重啟，而
        // server 其實 1 秒後就恢復、provider 內建退避在 t=2 秒就連上了——留著的話，t=5 秒
        // 那顆 timer 會把一條健康的連線拆掉重來，還多花一次 collab-token 的額度（那是
        // per-user 跨分頁共用的）。使用者看不到（自家 close 會被 pendingReconnectRef 吞掉），
        // 只會白白多繞一圈。
        if (restartTimer !== undefined) clearTimeout(restartTimer);
        restartTimer = undefined;
        cancelRestartFallback?.();
        cancelRestartFallback = undefined;
        dispatch({ type: "open", role: roleRef.current });
      },
    });

    // issue #39：token 徹底取不到時的自我修復。延遲逐格拉長、最後一格重複使用（永遠會
    // 再試）；成功認證一次就歸零（見 `onAuthenticated`）。同一時間只排一個。
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelRestartFallback: (() => void) | undefined;
    /** 終態（kicked／deleted）之後不得再重啟——見下方 `stopRestartsRef` 的接線。 */
    let restartsStopped = false;
    const scheduleRestart = () => {
      if (disposed || restartsStopped || restartTimer !== undefined) return;
      const index = Math.min(restartAttempt, TOKEN_RESTART_DELAYS_MS.length - 1);
      restartAttempt += 1;
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        if (disposed) return;
        cancelRestartFallback?.();
        cancelRestartFallback = restartConnection(provider, pendingReconnectRef);
      }, jittered(TOKEN_RESTART_DELAYS_MS[index]!));
    };

    // issue #48：追蹤「同步過了沒」。只在 false→true 邊緣 emit，且 StrictMode 重掛時
    // 可能已經同步完（事件錯過），所以比照 NotePage 的護欄：訂閱後立刻補查一次 getter。
    // 刻意**只設 true、從不設回 false**——見 UseCollabResult.synced 的說明。
    const handleSynced = () => {
      if (provider.synced) setSynced(true);
    };
    provider.on("synced", handleSynced);
    if (provider.synced) handleSynced();

    provider.on("close", ({ event }: { event?: { reason?: string } }) => {
      const reason = event?.reason ?? "";
      const isAppLevel = reason === COLLAB_CLOSE_REVOKED || reason === COLLAB_CLOSE_NOTE_DELETED;
      if (!isAppLevel && pendingReconnectRef.current) {
        // 這是我們自己 disconnect() 造成的 close：不進狀態機（否則會把
        // reconnecting-once 打回 connecting），並且**就在這裡**發動那唯一一次重連
        // ——此刻 socket 才真的關掉、status 才是 Disconnected（見檔頭說明）。
        pendingReconnectRef.current = false;
        void provider.connect();
        return;
      }
      dispatch({ type: "close", reason });
    });

    // server 的 permission-denied（`onAuthenticate` 拒連）——**不伴隨任何 close**，沒接這條
    // 就是 issue #6 的「卡在連線中」。詳見檔頭。
    provider.on("authenticationFailed", ({ reason }: { reason?: string }) => {
      if (tokenFetchFailed) {
        // 這一則是我們自家 token function 丟錯換來的，不是授權裁決：401 已經走過
        // `onUnauthorized`、404 已經自己收斂 deleted，其餘（5xx/網路）是暫時性的，一律
        // 不得踢人（N7）。
        //
        // 但也不能就這樣算了（issue #39）：此刻 socket 開著卻沒通過認證，provider 不會再取
        // 一次 token，狀態機也收不到任何事件——不排一次重啟的話這條連線就是靜默死掉，
        // server 恢復了也不會自己好。
        tokenFetchFailed = false;
        if (!tokenFailureFinal) scheduleRestart();
        return;
      }

      // ⚠ 一律先把 reason 收成字串再比對，**不可**寫成裸的 `reason === COLLAB_REJECT_*`：
      // reason 缺席時兩邊都是 undefined 會變成真，把一則不明的拒絕誤判成「筆記已刪除」。
      // 開發時就踩過：共用包忘了重建，常數全是 undefined，測試因此假綠。
      const wire = typeof reason === "string" ? reason : "";

      // issue #35：拒連理由分兩桶，處置完全不同（見 `@knotebook/shared` 那組常數的註解）。
      // A 桶＝授權裁決，照舊翻成 close 事件走既有的終態／二擊語意。
      if (wire === COLLAB_REJECT_NOTE_DELETING) {
        dispatch({ type: "close", reason: COLLAB_CLOSE_NOTE_DELETED });
        return;
      }
      if (wire === COLLAB_REJECT_FORBIDDEN) {
        dispatch({ type: "close", reason: COLLAB_CLOSE_REVOKED });
        return;
      }

      // B 桶＝`invalid-token`／`server-error`／不認得的 reason（含 Hocuspocus 對未預期例外
      // 填的字面值 `"permission-denied"`）。**這些都不是「你沒有權限」**：token 驗不過、
      // session 的 tokenVersion 被撤銷（帳號停用／別處改過密碼）、server 端 DB 抖動都會落在
      // 這裡，舊版一律翻成撤權 ⇒ 對一個權限完好的使用者說「你已失去存取權」並把他導走
      // （issue #35）。
      //
      // 但也不能就這樣不動：server 對 onAuthenticate 的 throw **不關 socket 也不重連**，
      // provider 不會再取一次 token，狀態機收不到任何事件 ⇒ 又是一條靜默死路（issue #34/#39
      // 那一族）。所以走與「token 取不到」相同的自我修復：排一次整條連線重啟（會重取
      // token），狀態留在 `connecting`。tokenVersion 被撤銷那一支的重取會拿到 401（session
      // 也失效了），屆時 `onUnauthorized` 會接手登出——那才是它正確的結局。
      scheduleRestart();
    });

    // 終態分支（下面那個 effect）用它把重啟整條掐掉。**必須有這道閘門**（審查指出）：
    // 401 與 404 兩支都會 rethrow ⇒ `tokenFetchFailed` ⇒ `authenticationFailed` ⇒ 照排一次
    // 重啟，於是「狀態機已宣告終態」的連線還會被 timer 重新拉起來、對一篇已經沒有權限或
    // 已刪除的筆記再打一發 collab-token。實務上被 NotePage 的導頁卸載擋住，但 `useCollab`
    // 自己的「終態不再重連」不變量不該押在呼叫端的導頁行為上。
    stopRestartsRef.current = () => {
      restartsStopped = true;
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      restartTimer = undefined;
      cancelRestartFallback?.();
      cancelRestartFallback = undefined;
    };

    providerRef.current = provider;
    setSession({ doc, provider });

    return () => {
      disposed = true;
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      cancelRestartFallback?.();
      stopRestartsRef.current = null;
      providerRef.current = null;
      provider.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [noteId, dispatch]);

  // 狀態 → provider 動作。reducer 保持純粹，所有副作用集中在這裡。
  useEffect(() => {
    const provider = providerRef.current;
    if (!provider) return;

    if (state.phase === "reconnecting-once") {
      // 第一發撤權 close：關掉這條 socket（server 端的應用層 CLOSE 只送訊息、不關
      // socket）。重連由 `"close"` 監聽器收到自家 close 時發動——見檔頭「不能同步
      // connect()」。重連會重跑 token function，取回的 role 就是第二擊的判準。
      return restartConnection(provider, pendingReconnectRef);
    }

    if (isTerminal(state)) {
      // 終態不再重連：`disconnect()` 會把 shouldConnect 設為 false，停掉內建退避。
      // issue #39 的重啟排程也要一起掐掉，否則它會把終態的連線重新拉起來。
      stopRestartsRef.current?.();
      pendingReconnectRef.current = false;
      provider.disconnect();
    }
  }, [state]);

  return { state, doc: session?.doc ?? null, provider: session?.provider ?? null, synced };
}
