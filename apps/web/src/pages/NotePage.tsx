import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type NoteDto, type Role } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { useNote } from "@/api/notes";
import { SESSION_QUERY_KEY, useSession } from "@/auth/useSession";
import { canEdit, isTerminal, type CollabState } from "@/collab/connection";
import { createLinkSync, type LinkSync } from "@/collab/link-sync";
import { useCollab } from "@/collab/useCollab";
import { AppShell } from "@/components/AppShell";
import { BacklinksSection } from "@/components/BacklinksSection";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { NoteEditor } from "@/components/NoteEditor";
import { ShareDialog } from "@/components/ShareDialog";
import { TitleInput } from "@/components/TitleInput";
import { toast } from "@/components/ui/toast";

/** 終態後兩次重抓之間的間隔。 */
const TERMINAL_RECONCILE_INTERVAL_MS = 750;

/**
 * 終態後的對帳總時限。**server 最壞情況 5s + 餘裕**：`DELETE /api/notes/:id` 會先
 * `await beforeNoteDeleted(id)`（內含 unload 輪詢上限 20 × 250ms = 5s，見
 * `apps/server/src/collab/hooks-impl.ts`）**才**跑刪除交易，所以我們收到
 * NOTE_DELETED 之後，那一列最久可能還在 DB 裡待 5 秒。
 */
const TERMINAL_RECONCILE_TIMEOUT_MS = 6_000;

/**
 * 終態（撤權／刪除）之後把 `['notes']` 跟 server 對齊——**有上限的重抓輪詢**，不是
 * 抓一次就算。
 *
 * 為什麼需要輪詢：server 的 `DELETE /api/notes/:id` 是「**先**關掉所有共編連線
 * （`beforeNoteDeleted`）、**再**跑刪除交易」（那個順序本身有正當理由：反過來會寫出
 * 孤兒 `note_states`，見 routes/notes.ts）。也就是說我們收到 NOTE_DELETED 的當下，
 * 那一列在 DB 裡**還在**，而且最久可能還要 5 秒才消失。任何「單發」的重抓——不論
 * 立刻抓還是固定延遲抓——都可能落在交易 commit 之前，撈回仍含這篇筆記的清單並把
 * 呼叫端剛做完的同步修正整個蓋掉（而且重抓成功還會清掉 invalidated 旗標，側欄就
 * 一路髒到整頁重載為止）。
 *
 * 因此：抓一次 → 若該筆還在就隔 `TERMINAL_RECONCILE_INTERVAL_MS` 再抓 → 直到它消失
 * 或到達 `TERMINAL_RECONCILE_TIMEOUT_MS` 為止，逾時就放手（絕不無限輪詢）。
 * `refetchType: 'all'`：換頁的縫隙裡 `['notes']` 可能一個 observer 都沒有，預設的
 * `'active'` 那時只會標記過期而不真的抓。
 *
 * 這些 timer 刻意**不**提供取消：呼叫端緊接著就會 `navigate` 把頁面卸載，能取消就
 * 等於什麼都沒做。`queryClient` 是 app 層級物件（活得比這個頁面久），對它 invalidate
 * 安全且冪等，而且整串輪詢有硬性時限。
 */
export function scheduleTerminalReconcile(queryClient: QueryClient, noteId: string | undefined): void {
  const deadline = Date.now() + TERMINAL_RECONCILE_TIMEOUT_MS;

  const stillListed = (): boolean =>
    queryClient.getQueryData<NoteDto[]>(["notes"])?.some((candidate) => candidate.id === noteId) ?? false;

  const tick = async (): Promise<void> => {
    try {
      await queryClient.invalidateQueries({ queryKey: ["notes"], refetchType: "all" });
    } catch {
      // 抓取失敗（離線、5xx…）不該讓對帳提早收工——照時程繼續試到期限為止。
    }
    if (!noteId || !stillListed() || Date.now() >= deadline) return;
    setTimeout(() => void tick(), TERMINAL_RECONCILE_INTERVAL_MS);
  };

  void tick();
}

/** 連上之後以共編回報的角色為準；還沒連上（或已終止）時退回 REST 給的角色。 */
function effectiveRole(state: CollabState, note: NoteDto): Role {
  return state.phase === "connected" ? state.role : note.role;
}

/**
 * `/notes/:ref` 編輯頁。
 *
 * 進頁流程（spec §5）：`useNote(ref)`（ref 可以是 slug、`<vanity>-<uuid>` 或純 uuid，
 * 由 server 的 `GET /api/notes/:ref` 解析）→ 拿到 id → `history.replaceState` 到
 * canonical 網址 → `useCollab(id)` 建共編連線 → provider/doc 備妥後掛載 `NoteEditor`。
 *
 * 為什麼是 `history.replaceState` 而不是 `navigate(..., {replace:true})`：後者會改動
 * 路由參數 `ref`，`useNote(ref)` 的 query key 跟著變 → 整頁重新載入、編輯器連同共編
 * 連線一起被扯掉。網址只是門面，換網址不該重掛連線。副作用是 react-router 的
 * location 會跟真實網址不同步，所以任何「這是不是目前開啟的筆記」的判斷一律走
 * `matchesNoteRef(params.ref, note)` 而不是比對 pathname（見 `@/lib/note-ref`）。
 *
 * 終態處理：`kicked`（撤權雙擊確認）與 `deleted`（筆記被刪）都是 toast + 導回 `/`。
 * N4 降級（editor → viewer）不是終態：連線留著，只是 `editable` 變 false 並 toast。
 */
export default function NotePage() {
  const { ref = "" } = useParams<{ ref: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useSession();

  const noteQuery = useNote(ref);
  const note = noteQuery.data;
  const noteId = note?.id;

  // 401：session 真的沒了（不是撤權）。清掉 ['me'] 並導去登入頁——與 UserMenu 的
  // 登出流程同一套終點，只是沒有 server round-trip 可打。
  const handleUnauthorized = useCallback(() => {
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
    void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    void navigate("/login", { replace: true });
  }, [navigate, queryClient]);

  const { state, doc, provider, synced } = useCollab({ noteId, onUnauthorized: handleUnauthorized });

  // wikilink 連結索引提交器（Task 7，spec §12.3 client 段）。掛載定案在這裡（不是
  // NoteEditor）：`noteId`／`useCollab` 的 `doc`／`provider` 都在這一層。
  //
  // `canEditRef` 在 render 當下（非 effect 內）同步寫入——與 `useCollab.ts` 的
  // `onUnauthorizedRef.current = onUnauthorized` 同一手法：下面的掛載 effect deps
  // 刻意限定 `[noteId, doc, provider]`（五輪 plan-gate 定案的「synced 訂閱三護欄」
  // 之一，見 `link-sync.ts` 檔頭），不能含 `state`/`note`——那樣連線本身沒換手也會
  // 因為角色變動整個重訂閱，讓 provider 的 `synced` 事件（只在 false→true 邊緣
  // emit 一次）錯過訂閱窗口，該連線就永遠不會提交。`canEdit` 判定因此只能透過 ref
  // 在 effect「啟動當下」讀取一次快照（對應 brief「掛載時 canEdit 為真才 start()」），
  // 不能進 deps。
  const canEditRef = useRef(false);
  canEditRef.current = note ? canEdit(effectiveRole(state, note)) : false;
  const linkSyncRef = useRef<LinkSync | null>(null);

  useEffect(() => {
    if (!noteId || !doc || !provider) return;

    const linkSync = createLinkSync({ noteId, doc, api });
    linkSyncRef.current = linkSync;
    if (canEditRef.current) linkSync.start();

    // 護欄③：訂閱後立刻檢查一次目前的 synced 狀態並補呼叫——`synced` 是 public
    // getter（`provider.synced`），若這個 effect 是在 provider 早已同步完成之後才
    // 掛上去的（例如 StrictMode 重掛、或本來就慢了一步），false→true 的那個邊緣
    // 事件已經 emit 過、不會再等到，必須自己補這一次才不會整條連線永遠不提交。
    const handleSynced = () => linkSync.onSynced();
    provider.on("synced", handleSynced);
    if (provider.synced) handleSynced();

    return () => {
      provider.off("synced", handleSynced);
      linkSync.stop();
      linkSyncRef.current = null;
    };
  }, [noteId, doc, provider]);

  // 403 閂的解閂觀察窗（spec §12.3）：獨立成一個 effect，deps 才能安全含 `state`
  // 而不影響上面那個訂閱 effect 的 deps 限制。
  useEffect(() => {
    linkSyncRef.current?.onCollabState(state);
  }, [state]);

  // canonical 網址：只在跟目前網址不同時才改寫，避免每次 render 都往 history 塞東西。
  useEffect(() => {
    if (!note) return;
    const canonical = canonicalNotePath(note);
    if (window.location.pathname === canonical) return;
    window.history.replaceState(window.history.state, "", canonical);
  }, [note]);

  // 「已經決定要離開這一頁了」。共編終態與 API 404 是兩條互相獨立、可能**同時**成立的
  // 離場路徑（筆記被刪時 close(NOTE_DELETED) 與 `GET /api/notes/:ref` 的 404 會前後腳
  // 到），共用同一道閘門才不會噴兩則一模一樣的 toast、導兩次頁。`navigate` 之後這個
  // 元件還會再 render 至少一次，所以閘門是必要的而不只是保險。
  const leavingRef = useRef(false);

  // 找不到筆記（被刪、或分享被撤銷後重新整理）：跟共編的 `deleted` 終態同一個出口。
  const notFound = noteQuery.isError && noteQuery.error instanceof ApiFail && noteQuery.error.status === 404;
  useEffect(() => {
    if (!notFound || leavingRef.current) return;
    leavingRef.current = true;
    toast({ title: t("note.deleted"), variant: "destructive" });
    void navigate("/", { replace: true });
  }, [navigate, notFound, t]);

  useEffect(() => {
    if (!isTerminal(state) || leavingRef.current) return;
    leavingRef.current = true;
    toast({
      title: state.phase === "kicked" ? t("note.accessRevoked") : t("note.deleted"),
      variant: "destructive",
    });
    // 兩種終態都代表「這篇筆記對我而言已經不存在」，側欄不能再留著它——點進去只會
    // 再被踢一次。
    //
    // 兩段式：① 先**同步**把它從 `['notes']` 濾掉，讓畫面在下一次 render 就正確；
    // ② 交給 `scheduleTerminalReconcile` 做有上限的重抓輪詢跟 server 對齊。
    // ①**不能單獨成立**：`navigate` 之後 NoteList 會重新掛載，預設 `staleTime: 0`
    // 的 refetch-on-mount 會立刻重抓，而 server 此時很可能還沒 commit 刪除交易，
    // 於是幽靈列被撈回來——真正把它清掉的是 ②。①仍然保留，因為它讓「重抓還沒回來
    // 的那段時間」畫面是對的，成本只有一行。
    queryClient.setQueryData<NoteDto[]>(["notes"], (previous) =>
      previous?.filter((candidate) => candidate.id !== noteId),
    );
    scheduleTerminalReconcile(queryClient, noteId);
    void navigate("/", { replace: true });
  }, [navigate, noteId, queryClient, state, t]);

  // N4：連線中的角色變動（撤權降級為 viewer／權限恢復）要讓使用者知道。
  // 恢復沒有 server 通知，靠的是下一次 token 往返帶回來的 role（見 useCollab）。
  const previousRoleRef = useRef<Role | null>(null);
  useEffect(() => {
    if (state.phase !== "connected") return;
    const previous = previousRoleRef.current;
    previousRoleRef.current = state.role;
    if (previous === null || previous === state.role) return;
    // 只對「真的變成 viewer」報降級。角色變 'none' 是撤權流程的前半段（server 緊接著
    // 就會送 REVOKED close），若也在這裡 toast，使用者會先看到「已改為檢視者」再看到
    // 「已失去存取權」——兩則互相矛盾的訊息（瀏覽器實測到的雜訊）。
    if (state.role === "viewer" && canEdit(previous)) {
      toast({ title: t("note.downgradedToViewer") });
    } else if (canEdit(state.role) && !canEdit(previous)) {
      toast({ title: t("note.restoredEditAccess") });
    }
  }, [state, t]);

  let body;
  if (noteQuery.isPending) {
    body = <p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>;
  } else if (noteQuery.isError) {
    body = (
      <p role="alert" className="p-6 text-sm text-destructive">
        {noteQuery.error instanceof ApiFail
          ? t(`errors.${noteQuery.error.code}`, { defaultValue: t("errors.fallback") })
          : t("errors.fallback")}
      </p>
    );
  } else {
    const role = effectiveRole(state, note!);
    // 角色允不允許編輯（不看連線）：標題、分享這類**走 REST 的操作**用這個判準。
    const roleCanEdit = !isTerminal(state) && canEdit(role);
    // issue #48：**Y.Doc 的內容編輯**還要求同步過。第一次 sync 之前本機 Y.Doc 是空的——
    // 這時的「可編輯」是一篇空白但看似正常的筆記，打的字只進本機、重整就沒了（沒有
    // y-indexeddb）。同步過一次之後 `synced` 就 sticky true，斷線仍可編輯（那些離線編輯
    // 會被 #39 的重啟併回），只是 badge 會升級成警示。
    // ⚠ **標題不套這個閘門**（審查指出）：標題走 REST 的 last-write-wins、不走 Yjs（見
    // `TitleInput` 檔頭），值來自已成功的 `GET /api/notes/:ref`——連不上共編但 REST 正常
    // 時，改標題完全安全、重整也真的在。跟著 synced 一起鎖死是功能倒退。
    const editable = roleCanEdit && synced;
    body = (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-4 border-b border-border px-6 py-4">
          <TitleInput note={note!} readOnly={!roleCanEdit} cacheRef={ref} />
          <ShareDialog note={note!} cacheRef={ref} />
          <ConnectionBadge state={state} synced={synced} />
        </header>
        {/* Task 6：捲動容器內移進 `NoteEditor`（左欄一份、右側 AI 側欄一份，各自獨立
            捲動）——這裡只留 `flex-1 min-h-0`。`min-h-0` 是必要的：flex 子項預設
            `min-height:auto` 會撐開到內容高度，讓 `NoteEditor` 內層的 `overflow-y-auto`
            形同虛設，畫面變成整個外層一起捲、AI 側欄跟著正文捲走，寬螢幕並排的版面就壞了
            （這類改法最常見的靜默失敗，brief 明文強調）。 */}
        <div className="min-h-0 flex-1">
          {doc && provider && user ? (
            <NoteEditor
              doc={doc}
              provider={provider}
              editable={editable}
              user={{ id: user.id, name: user.displayName }}
              noteId={noteId!}
            />
          ) : (
            <p className="px-4 py-4 text-sm text-muted-foreground">{t("app.loading")}</p>
          )}
        </div>
        {/* 手動 UI 驗收回饋：backlinks 區要固定高度上限、內文獨立捲動，不能讓篇數一多
            就把版面往下推、逼出頁面級捲動——三面板（編輯器欄／AI 側欄／這一區）都要是
            視口鎖定＋各自捲動（根本原因與修法見 `AppShell.tsx` 的同一則註解：那裡把
            `h-full` 這條鏈從 `min-h-screen` 改成真正鎖視口的 `h-screen`，這裡才吃得到
            效果）。`shrink-0` 讓這一區不被上面 `flex-1` 的中段吃掉高度、`max-h-48`
            （12rem）是這次驗收目測抓的上限（不是精確量出來的數字，純觀感取捨，落在
            brief 建議的 max-h-40~56 區間）、`overflow-y-auto` 讓超出上限的部分自己捲，
            不再往外撐。`BacklinksSection` 內部（`<ul>` 上）其實已經有一份等效的
            `max-h-48 overflow-y-auto`（Task 6b 就有），這裡加的是外層保險：0 篇時
            `BacklinksSection` 回傳 `null`，這個容器沒有子內容、高度塌成 0，不影響
            「0 篇整塊隱藏」的既有行為。 */}
        <div className="max-h-48 shrink-0 overflow-y-auto">
          <BacklinksSection noteId={noteId} />
        </div>
      </div>
    );
  }

  return <AppShell>{body}</AppShell>;
}
