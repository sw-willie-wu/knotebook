import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  COLLAB_CLOSE_NOTE_DELETED,
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_NOTE_DELETING,
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

/** 進 `reconnecting-once` 後，等自家 close 事件回來的上限；逾時就直接重連。 */
const RECONNECT_FALLBACK_MS = 1_000;

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
 * - `authenticationFailed`（server 的 permission-denied）→ 翻成對應的 `close` 事件：
 *   note-deleting → NOTE_DELETED，其餘一律 REVOKED（因而共用同一套二擊語意）。
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
 * 翻成 `close(REVOKED)` 而不另開一個終態，是為了**沿用同一套二擊語意**：第一擊進
 * `reconnecting-once`（於是 disconnect → 重取 token 連一次），第二擊（重連拿回的 role 是
 * `'none'`、或再次被拒）才收斂 `kicked`。伺服器一次性抖動（DB 掉拍…）因此不會誤殺
 * 一個合法使用者，而真的撤權一定收斂。`note-deleting` 是例外：刪除閘門是定局的，
 * 直接走 `deleted`（等同 `close(NOTE_DELETED)`），不浪費一次重連。
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

  // provider 建立時就同步寫進 ref：狀態副作用 effect（disconnect/connect）不能等
  // `setSession` 的 re-render 才拿得到 provider。
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const roleRef = useRef<Role>("none");
  /** 「我們自己剛叫了 disconnect()，正在等那條 close 回來好接著重連一次」。 */
  const pendingReconnectRef = useRef(false);
  /**
   * 「最近一次 token function 是以丟錯收場的」。provider 在 `getToken()` 丟錯時會直接
   * 呼叫 `permissionDeniedHandler`（見 @hocuspocus/provider 的 `sendToken`），於是
   * `authenticationFailed` 也會為我方的 5xx/網路失敗而發——那不是 server 的授權裁決，
   * 不得據此把人踢出（spec N7）。兩者共用同一個事件名，只有我們自己分得出來。
   */
  const tokenFetchFailedRef = useRef(false);
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
    roleRef.current = "none";
    pendingReconnectRef.current = false;

    let disposed = false;
    const doc = new Y.Doc();

    const fetchTokenWithRetries = async (): Promise<string> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const body = await api<CollabTokenResponse>(`/api/notes/${encodeURIComponent(noteId)}/collab-token`, {
            method: "POST",
          });
          roleRef.current = body.role;
          dispatch({ type: "token-role", role: body.role });
          return body.token;
        } catch (err) {
          if (err instanceof ApiFail && err.status === 401) {
            // session 沒了：登出流程，不重試也不當成撤權。
            onUnauthorizedRef.current();
            throw err;
          }
          if (err instanceof ApiFail && err.status === 404) {
            // 保險絲：目前的 server 契約下這條不會發生（token endpoint 對無權限／
            // 已刪除的筆記一律回 200 + role 'none'，見 routes/notes.ts 的說明），
            // 但 spec §5 明訂「重連時 API 404 → deleted」，契約若改動也要正確收斂。
            dispatch({ type: "close", reason: COLLAB_CLOSE_NOTE_DELETED });
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
    // `tokenFetchFailedRef`。每次進場先清旗標：成功的一次不能留下殘影，去吞掉之後
    // 真正的拒絕。
    const fetchToken = async (): Promise<string> => {
      tokenFetchFailedRef.current = false;
      try {
        return await fetchTokenWithRetries();
      } catch (err) {
        tokenFetchFailedRef.current = true;
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
        dispatch({ type: "open", role: roleRef.current });
      },
    });

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
      if (tokenFetchFailedRef.current) {
        // 這一則是我們自家 token function 丟錯換來的，不是授權裁決：401 已經走過
        // `onUnauthorized`、404 已經自己收斂 deleted，其餘（5xx/網路）是暫時性的，一律
        // 不得踢人（N7）。
        tokenFetchFailedRef.current = false;
        return;
      }
      // 不寫成裸的 `reason === COLLAB_REJECT_NOTE_DELETING`：reason 缺席時兩邊都是
      // undefined 會變成真，把一則不明的拒絕誤判成「筆記已刪除」。開發時就踩過：
      // 共用包忘了重建，兩個常數都是 undefined，測試因此假綠。
      const noteDeleting = reason !== undefined && reason === COLLAB_REJECT_NOTE_DELETING;
      dispatch({ type: "close", reason: noteDeleting ? COLLAB_CLOSE_NOTE_DELETED : COLLAB_CLOSE_REVOKED });
    });

    providerRef.current = provider;
    setSession({ doc, provider });

    return () => {
      disposed = true;
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
      pendingReconnectRef.current = true;
      provider.disconnect();
      // 保險絲：socket 早就不在時 `disconnect()` 會直接 return、不會有 close 事件，
      // 那樣 pending 旗標會永遠掛著、重連也永遠不發生。逾時就自己補一次。
      const fallback = setTimeout(() => {
        if (!pendingReconnectRef.current) return;
        pendingReconnectRef.current = false;
        void provider.connect();
      }, RECONNECT_FALLBACK_MS);
      return () => clearTimeout(fallback);
    }

    if (isTerminal(state)) {
      // 終態不再重連：`disconnect()` 會把 shouldConnect 設為 false，停掉內建退避。
      pendingReconnectRef.current = false;
      provider.disconnect();
    }
  }, [state]);

  return { state, doc: session?.doc ?? null, provider: session?.provider ?? null };
}
