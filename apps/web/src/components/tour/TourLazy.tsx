import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type AiActionDto, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteNote } from "@/api/notes";
import { toast } from "@/components/ui/toast";
import "@/i18n/tour-strings";
import type { TourStartOptions } from "@/lib/tour-context";
import { getTourNoteEditor, onEditorEditable, type TourEditor } from "@/lib/tour-bridge";
import { focusReturnTarget, RETURN_FOCUS_TIMEOUT_MS, samePath, waitForFrames } from "./engine";
import { createSampleNote, seedSampleNote } from "./sample-note";
import { TourRunner, type TourResult } from "./TourRunner";

/**
 * 導覽的 lazy chunk 入口（`TourProvider` 第一次開始導覽時才 `import()` 這支）：示範筆記的準備、開始流程的中止，
 * 以及整輪的 `TourRunner`。
 */

export interface TourLazyProps extends TourStartOptions {
  /** 從按下開始起已經超過開始流程的上限：第 1 站還沒出現就中止。 */
  timedOut: boolean;
  /** 第 1 站出現時呼叫一次。 */
  onStarted: () => void;
  /** 這一輪結束（正常結束或中止）時呼叫一次；之後「進行中」就清掉。 */
  onDone: () => void;
}

/**
 * 示範筆記準備到哪：`preparing` 還沒寫入內容；`seeded` 寫入那一步正常回傳過（不論真的寫了沒有）；`aborted` 已中止。
 * 中止與寫入共用這一個值：寫入只在 `preparing` 時做，中止只在不是 `seeded` 時把它改成 `aborted`，
 * 所以中止之後才回來的讀取不會再寫入，寫入過的筆記也不會被當成空白筆記丟掉。
 */
type SamplePhase = "preparing" | "seeded" | "aborted";

interface Session {
  phase: SamplePhase;
  note: NoteDto | null;
  /** 已經跳過一則失敗提示（建立失敗或開始失敗）：同一輪不再跳第二則。 */
  notified: boolean;
  started: boolean;
  /** 已經到過示範筆記的頁面：之後位置離開它才算「離開」。 */
  arrived: boolean;
  /** 結束或中止的處理已經開始。 */
  ending: boolean;
  /**
   * 中止的處理已經決定好示範筆記的去留（要移的也送出了）。在這之前由中止的處理負責移垃圾桶（它會先導回原頁）；
   * 之後才回來的 POST，那篇由 `prepareSample` 自己移。
   */
  settled: boolean;
  /** 已經把示範筆記送去垃圾桶。 */
  discarded: boolean;
}

const NEVER = new AbortController().signal;

function describeError(t: TFunction, err: unknown): string | undefined {
  return err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : undefined;
}

/** 等這篇筆記的編輯器登記上來而且可編輯（可編輯＝已同步、角色可寫）；中止就回 null。 */
function waitForEditableEditor(noteId: string, signal: AbortSignal): Promise<TourEditor | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let unsubscribe = () => {};
    const finish = (editor: TourEditor | null) => {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      resolve(editor);
    };
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort);
    unsubscribe = onEditorEditable((id, editor) => {
      if (id === noteId) finish(editor);
    });
    // 訂閱前就已經可編輯的實例不會補通知。
    const current = getTourNoteEditor(noteId);
    if (current?.isEditable) finish(current);
  });
}

export function TourLazy({ returnTo, returnFocus, timedOut, onStarted, onDone }: TourLazyProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const deleteNote = useDeleteNote();
  const [runnerMounted, setRunnerMounted] = useState(true);
  const sessionRef = useRef<Session>({
    phase: "preparing",
    note: null,
    notified: false,
    started: false,
    arrived: false,
    ending: false,
    settled: false,
    discarded: false,
  });
  const locationRef = useRef(location);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  /** 移到垃圾桶，不跳垃圾桶提示（開始失敗那則已經說了）；這一篇只送一次。中止後元件可能已經卸載，送出照樣會跑。 */
  const discard = (note: NoteDto) => {
    const session = sessionRef.current;
    if (session.discarded) return;
    session.discarded = true;
    deleteNote.mutateAsync(note.id).catch((err: unknown) => console.error(err));
  };

  /**
   * 開始流程中止（逾時、位置離開示範筆記、沒辦法準備）：跳一則提示、收掉這一輪；示範筆記還沒寫入內容就移到垃圾桶。
   * 要移的筆記正開著時先導回原頁、等位置生效再移：開著的筆記被移到垃圾桶，筆記頁會走「已被刪除」的離場路徑、再跳一則提示。
   * 收掉 `TourRunner` 會中止 `prepareSample`，它的 `bail` 比導回原頁的 transition 先跑；這裡跑著的期間（`ending` 且還沒 `settled`）
   * 移垃圾桶只由這裡做，`bail` 不動手，「先導回再移」才成立。最後把焦點還給 `returnFocus`（使用者選單的觸發鈕；窄視窗是開側欄抽屜的漢堡鈕）。
   * 使用者自己導到別處而中止時也一樣還焦點，與導覽正常結束、或第 1 站之後離開示範筆記時的行為一致。
   */
  const abortStart = async () => {
    const session = sessionRef.current;
    if (session.ending) return;
    session.ending = true;
    const keep = session.phase === "seeded";
    if (!keep) session.phase = "aborted";
    if (!session.notified) {
      session.notified = true;
      toast({ title: t("tourGuide.startFailed"), variant: "destructive" });
    }
    setRunnerMounted(false);
    const note = session.note;
    if (!keep && note !== null) {
      if (samePath(locationRef.current.pathname, canonicalNotePath(note))) {
        const from = locationRef.current.key;
        void navigate(returnTo, { replace: true });
        await waitForFrames(() => (locationRef.current.key !== from ? true : null), NEVER, RETURN_FOCUS_TIMEOUT_MS);
      }
      discard(note);
    }
    session.settled = true;
    await focusReturnTarget(returnFocus, NEVER);
    onDone();
  };
  const abortFromEffect = useEffectEvent(() => void abortStart());

  /**
   * 建示範筆記、導過去、等它可編輯、寫入示範內容。每個 await 回來都先看是不是已經中止：中止了就不寫入，
   * 建好的筆記移到垃圾桶（中止時 POST 還沒回來的那篇，也在這裡移）。
   */
  const prepareSample = async (signal: AbortSignal, aiActions: Promise<AiActionDto[]>): Promise<NoteDto | null> => {
    const session = sessionRef.current;
    const stopped = () => session.phase === "aborted" || signal.aborted;
    const bail = () => {
      if (session.phase !== "seeded") session.phase = "aborted";
      if (session.note !== null && session.phase === "aborted" && (!session.ending || session.settled)) discard(session.note);
      return null;
    };
    if (stopped()) return null;
    let note: NoteDto;
    try {
      note = await createSampleNote(queryClient, t);
    } catch (err) {
      console.error(err);
      if (!stopped() && !session.notified) {
        session.notified = true;
        toast({ title: t("tourGuide.sampleFailed"), description: describeError(t, err), variant: "destructive" });
      }
      return null;
    }
    session.note = note;
    if (stopped()) return bail();
    // 訂閱「可編輯」與看現值都在 waitForEditableEditor 裡，所以在導頁前或後呼叫都不會漏掉那一次通知。
    const editable = waitForEditableEditor(note.id, signal);
    void navigate(canonicalNotePath(note));
    const editor = await editable;
    if (editor === null || stopped()) return bail();
    const titleShown = await waitForFrames(() => document.querySelector("input[data-note-title-input]"), signal);
    if (titleShown === null || stopped()) return bail();
    const actions = await aiActions;
    if (stopped()) return bail();
    try {
      seedSampleNote(editor, note, t, actions.length > 0);
    } catch (err) {
      // 文件還是空的：維持 `preparing`，中止時當成空白筆記移到垃圾桶。
      console.error(err);
      return null;
    }
    session.phase = "seeded";
    return note;
  };

  // 第 1 站出現之前，位置離開示範筆記（例如點了側欄別篇）＝中止。第 1 站之後由 `TourRunner` 當成結束處理。
  useEffect(() => {
    const session = sessionRef.current;
    if (session.started || session.ending || session.note === null) return;
    if (samePath(location.pathname, canonicalNotePath(session.note))) session.arrived = true;
    else if (session.arrived) abortFromEffect();
  }, [location.pathname]);

  // 逾時中不中止由這裡的 `started` 決定：第 1 站 commit 之後，下一次 render 前會先跑完 `handleStarted`，
  // 所以這裡看到的 `started` 已經是真的。TourProvider 收到 `onStarted` 停表只是清掉用不到的計時器。
  useEffect(() => {
    if (timedOut && !sessionRef.current.started) abortFromEffect();
  }, [timedOut]);

  const handleStarted = () => {
    sessionRef.current.started = true;
    onStarted();
  };

  const handleFinished = (result: TourResult) => {
    if (!result.started) {
      void abortStart();
      return;
    }
    sessionRef.current.ending = true;
    onDone();
  };

  if (!runnerMounted) return null;
  return (
    <TourRunner
      returnTo={returnTo}
      returnFocus={returnFocus}
      prepareSample={prepareSample}
      onStarted={handleStarted}
      onFinished={handleFinished}
    />
  );
}
