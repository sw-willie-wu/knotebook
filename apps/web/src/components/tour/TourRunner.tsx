import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type AiActionDto, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteNote } from "@/api/notes";
import { toast } from "@/components/ui/toast";
import { useSidebarQuery } from "@/lib/sidebar-query";
import type { SidebarTab } from "@/lib/sidebar-tab";
import { getShellControls } from "@/lib/tour-bridge";
import { useIsNarrowViewport } from "@/lib/tour-targets";
import { showTrashedToast, type Translate } from "@/lib/trash-undo";
import {
  fetchTourAiActions,
  focusReturnTarget,
  fullTourStops,
  measureTargets,
  planStops,
  RETURN_FOCUS_TIMEOUT_MS,
  samePath,
  TourEngine,
  waitForDrawerClosed,
  waitForFrames,
  type EndReason,
  type EngineSnapshot,
  type TourStartOptions,
  type TourStopEntry,
} from "./engine";
import type { Rect } from "./geometry";
import { stopTitle } from "./sequence";
import { isNarrowViewport, stopBodyKey, stopTarget, type StopContext } from "./stops";
import { TourOverlay } from "./TourOverlay";

export interface TourRunnerProps extends TourStartOptions {
  /**
   * 建示範筆記、導過去、等它可編輯並寫入示範內容，回傳那篇筆記；回 null＝沒辦法開始（提示由它自己處理）。
   * 元件卸載時 `signal` 會中止。`aiActions` 是這一輪唯一一次向 server 讀 AI 動作的結果（不會 reject，失敗是空陣列）：
   * 寫入示範內容時用它決定放不放 AI 那句，站點也用同一份，兩邊看到的答案才一致。
   */
  prepareSample: (signal: AbortSignal, aiActions: Promise<AiActionDto[]>) => Promise<NoteDto | null>;
  /** 第一站出現時呼叫，整輪恰好一次（重繪、往回走、StrictMode 都不會重複）。開始前中止的不呼叫。 */
  onStarted?: () => void;
  /** 導覽結束、還原做完之後呼叫一次；沒辦法開始時也呼叫。卸載時不呼叫。 */
  onFinished: (result: TourResult) => void;
  /** 要走的站；預設是完整導覽。 */
  stops?: readonly TourStopEntry[];
}

/**
 * 導覽怎麼結束的：
 * - `completed`：最後一站〔保留示範筆記〕或〔刪除〕。
 * - `closed`：✕、Esc、第 1 站的「跳過」。
 * - `left`：進過站之後，位置離開了示範筆記。
 * - `aborted`：第一站出現之前就停了（沒辦法準備示範筆記、讀 AI 動作期間離開頁面）。
 */
export type TourFinishReason = "completed" | "closed" | "left" | "aborted";

export interface TourResult {
  /** 第一站有沒有出現過。 */
  started: boolean;
  reason: TourFinishReason;
}

function finishReason(reason: EndReason, started: boolean): TourFinishReason {
  if (!started) return "aborted";
  if (reason === "keep" || reason === "delete") return "completed";
  return reason === "left" ? "left" : "closed";
}

interface Run {
  engine: TourEngine;
  note: NoteDto;
  path: string;
  /** 開始前的側欄 tab；沒有登記的側欄時是 null。 */
  tab: SidebarTab | null;
  ctx: StopContext;
}

const IDLE: EngineSnapshot = { phase: "idle", index: -1, total: 0, entry: null, pending: false, endReason: null };
const subscribeNothing = () => () => {};
const idleSnapshot = () => IDLE;

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** ApiFail → errors.<code>；其餘 → errors.fallback（各檔各自一份，是既有慣例）。 */
function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 跑一輪功能導覽：開始流程、換站、結束後的還原。整輪只畫一個 `TourOverlay`：換站時原地換掉內容，
 * 報讀器的換站通知（常駐的 live region）才讀得出來，重掛的話它會把每一站當成剛打開。
 *
 * - **開始**：先關側欄抽屜、等它從 DOM 消失（抽屜是 modal，開著時卡片按不到、目標全都查不到）→ 記下目前的側欄 tab →
 *   開始向 server 讀 AI 動作，同時 `prepareSample`（建示範筆記、導過去、寫入內容）→ 用同一次讀到的 AI 動作算前置條件、定站數 → 第一站。
 *   讀取和建筆記並行：等到編輯器可編輯時多半已經讀完，寫入示範內容不必再等一個來回（等的期間使用者在空筆記打的字會讓寫入作罷）。
 *   第一站出現之前不蓋遮罩。開始流程寫在掛載的 effect 裡、每一步之後看中止訊號：開發模式的 StrictMode
 *   掛載時會先卸載一次，第一輪在建示範筆記之前就會停下，不會建兩篇。這靠的是中止檢查之前有一個 `await`
 *   （等抽屜消失）：第一輪的 cleanup 在它回來之前就跑了；開頭改成不讓出執行權的話，第一輪會先把示範筆記建起來。
 * - **導覽中位置離開示範筆記**（上一頁、被導到登入頁、筆記在別處被刪……）就結束，不續跑，示範筆記留著。
 *   `prepareSample` 要等示範筆記的頁面掛上才回傳，所以第一次檢查時位置已經在示範筆記上。
 * - **結束**：寬視窗下 tab 與開始時不同就切回去（窄視窗切 tab 會順便打開抽屜，不切）；還在示範筆記上就導回 `returnTo`；
 *   等新的位置生效後，每格畫面用 `returnFocus()` 重新找觸發鈕來聚焦。〔刪除〕在導回原頁之後才移到垃圾桶：
 *   開著的筆記被刪掉，筆記頁會跳出「這篇已被刪除」的處理。
 */
export function TourRunner({ returnTo, returnFocus, prepareSample, onStarted, onFinished, stops }: TourRunnerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { query } = useSidebarQuery();
  const deleteNote = useDeleteNote();
  const narrow = useIsNarrowViewport();
  const [run, setRun] = useState<Run | null>(null);

  const readQuery = useEffectEvent(() => query);

  const startFlow = useEffectEvent(async (signal: AbortSignal) => {
    getShellControls()?.closeDrawer();
    await waitForDrawerClosed(signal);
    if (signal.aborted) return;
    const tab = getShellControls()?.getTab() ?? null;
    // 在等抽屜那個 await 之後才發：StrictMode 的第一輪在那裡就停，不會多讀一次。
    const aiRead = fetchTourAiActions(queryClient);
    let note: NoteDto | null = null;
    try {
      note = await prepareSample(signal, aiRead);
    } catch (err) {
      console.error(err);
    }
    if (signal.aborted) return;
    if (note === null) {
      onFinished({ started: false, reason: "aborted" });
      return;
    }
    const aiActions = await aiRead;
    if (signal.aborted) return;
    const ctx: StopContext = { searchQuery: readQuery(), aiActions };
    const engine = new TourEngine(planStops(stops ?? fullTourStops(), ctx), ctx);
    setRun({ engine, note, path: canonicalNotePath(note), tab, ctx });
  });

  useEffect(() => {
    const controller = new AbortController();
    void startFlow(controller.signal);
    return () => controller.abort();
  }, []);

  const snapshot = useSyncExternalStore(run?.engine.subscribe ?? subscribeNothing, run?.engine.getSnapshot ?? idleSnapshot);

  // 位置一變就看還在不在示範筆記上；只換 search／hash（例如簡報模式的 `?present`）不算離開。
  // 這支排在下面進第一站那支之前：開始時就已經不在示範筆記上的話，不進站。
  useEffect(() => {
    if (run === null || run.engine.getSnapshot().phase === "ended") return;
    if (!samePath(location.pathname, run.path)) run.engine.end("left");
  }, [location.pathname, run]);

  useEffect(() => {
    if (run === null) return;
    void run.engine.begin();
    return () => run.engine.end("unmount");
  }, [run]);

  // 第一站出現的訊號只發一次：ref 跟著元件實例，StrictMode 的模擬重掛、重繪、往回走都不會再發。
  const startedRef = useRef(false);
  const notifyStarted = useEffectEvent(() => onStarted?.());
  useEffect(() => {
    if (snapshot.index < 0 || startedRef.current) return;
    startedRef.current = true;
    notifyStarted();
  }, [snapshot.index]);

  // 導回原頁之後要等新的位置生效（新的側欄掛上）才找觸發鈕：太早找會找到正要卸載的舊側欄裡那顆。
  const locationKeyRef = useRef(location.key);
  useEffect(() => {
    locationKeyRef.current = location.key;
  }, [location.key]);

  const trashSample = useEffectEvent(async (note: NoteDto) => {
    try {
      await deleteNote.mutateAsync(note.id);
      showTrashedToast({ notes: [note], queryClient, navigate, t, reopen: false });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  });

  const finish = useEffectEvent(async (reason: EndReason, signal: AbortSignal) => {
    if (run === null) return;
    if (run.tab !== null && !isNarrowViewport()) {
      const shell = getShellControls();
      if (shell !== null && shell.getTab() !== run.tab) shell.showTab(run.tab);
    }
    // `returnTo` 是建示範筆記之前記下的位置，不會就是示範筆記。
    if (samePath(location.pathname, run.path)) {
      const from = locationKeyRef.current;
      // 取代掉示範筆記那一筆歷史：〔刪除〕之後按上一頁才不會回到垃圾桶裡的示範筆記。
      void navigate(returnTo, { replace: true });
      await waitForFrames(() => (locationKeyRef.current !== from ? true : null), signal, RETURN_FOCUS_TIMEOUT_MS);
      if (signal.aborted) return;
    }
    await Promise.all([focusReturnTarget(returnFocus, signal), reason === "delete" ? trashSample(run.note) : null]);
    if (signal.aborted) return;
    const started = run.engine.getSnapshot().index >= 0;
    onFinished({ started, reason: finishReason(reason, started) });
  });

  useEffect(() => {
    const reason = snapshot.endReason;
    if (snapshot.phase !== "ended" || reason === null || reason === "unmount") return;
    const controller = new AbortController();
    void finish(reason, controller.signal);
    return () => controller.abort();
  }, [snapshot.phase, snapshot.endReason]);

  // 挖洞每格畫面重新量：視窗縮放、捲動、DOM 變動、跨過寬窄判準（目標換成漢堡鈕）都跟著動。
  // 進站當下在 layout effect 先量一次，畫面上不會先閃一格沒有挖洞的卡片。
  const entry = snapshot.phase === "running" ? snapshot.entry : null;
  const [target, setTarget] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (entry === null || run === null) return;
    let frame = 0;
    const measure = () => {
      const next = measureTargets(stopTarget(entry.stop, run.ctx));
      setTarget((prev) => (sameRect(prev, next) ? prev : next));
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [entry, run]);

  if (entry === null || run === null) return null;
  const { engine } = run;
  return (
    <TourOverlay
      target={target}
      step={snapshot.index + 1}
      total={snapshot.total}
      title={stopTitle(t, entry.stop)}
      body={t(stopBodyKey(entry.stop, narrow))}
      onNext={() => engine.next()}
      onBack={() => engine.back()}
      onSkip={() => engine.end("close")}
      onClose={() => engine.end("close")}
      onKeep={() => engine.end("keep")}
      onDelete={() => engine.end("delete")}
    />
  );
}
