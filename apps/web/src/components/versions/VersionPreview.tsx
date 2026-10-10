import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { noteSchema } from "@/collab/schema";
import { useVersionList, useVersionSnapshot, VersionSnapshotMismatch } from "@/api/versions";
import { ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING } from "@/components/ui/article-column";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { diffBlocks, renderDiff, sideBySideMarks, type DiffBlock, type DiffEntry, type DiffMark, type DiffMarkInfo } from "@/lib/version-diff";
import { forkLiveBlocks, ydocBytesToBlocks } from "@/lib/version-snapshot";
import { safeMediaUrl } from "@/lib/media-url";
import { useContainerWidth } from "@/lib/use-container-width";
import { useVersions } from "@/lib/versions-context";
import { useTheme } from "@/theme";
import { cn } from "@/lib/utils";
import { ComparePicker } from "./ComparePicker";

/**
 * 並排的門檻（content box 寬，`useContainerWidth` 量；final §14-6，Willie 裁定 720）。門檻的唯一來源：
 * 不到門檻就不走並排渲染（只有單欄），所以並排的 grid 一律兩欄、不另用容器查詢。
 */
const SPLIT_MIN_WIDTH = 720;

const NO_MARKS: Map<string, DiffMark> = new Map();

/**
 * 唯讀 diff 編輯器（單欄、並排的一側、前後對話框共用）。**不掛 collaboration**、`editable={false}`；
 * `resolveFileUrl` 一律過 `safeMediaUrl`（RF2：快照可能帶協作者寫進去的危險網址，issue #12 同一道守衛）。
 * render 後依 `marks` 以 `data-id` 回貼 `data-diff`（spec §8.4）；沒在 marks 裡的區塊貼 `context`。
 *
 * `useCreateBlockNote(…, [blocks])` 在 `blocks` 身分一換就重建整顆編輯器——呼叫端傳進來的 `blocks` 必須是記憶化的參照
 * （見 `VersionPreview` 的 useMemo 鏈）。`data-diff` 貼在 `.bn-block-outer[data-id]` 上：Task 8 Step 1 探針在 jsdom 實跑，
 * 屬性經選取、空 meta、改別的區塊、同 id `replaceBlocks` 四種 transaction 都還在（唯讀編輯器本身不會再有 transaction）。
 */
export function DiffEditor({ blocks, marks, testId = "diff-pane" }: { blocks: DiffBlock[]; marks: Map<string, DiffMark | DiffMarkInfo>; testId?: string }) {
  const { resolvedTheme } = useTheme();
  const editor = useCreateBlockNote(
    {
      schema: noteSchema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PartialBlock 泛型三元組，repo 慣例
      initialContent: (blocks.length ? blocks : [{ type: "paragraph" }]) as any,
      resolveFileUrl: (url: string) => Promise.resolve(safeMediaUrl(url)),
    },
    [blocks],
  );
  useLayoutEffect(() => {
    const root = editor.domElement;
    if (!root) return;
    root.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]").forEach((el) => {
      const info = marks.get(el.dataset.id!);
      const mark = typeof info === "string" ? info : (info?.mark ?? "context");
      el.setAttribute("data-diff", mark);
      if (typeof info === "object" && info.moved && mark !== "moved") el.setAttribute("data-diff-moved", "true");
    });
  });
  return (
    <div data-testid={testId} className="kb-diff min-w-0">
      <BlockNoteView editor={editor} editable={false} theme={resolvedTheme} />
    </div>
  );
}

interface NonTextChange {
  key: string;
  before: DiffBlock;
  after: DiffBlock;
}

function collectNonText(entries: DiffEntry[], marks: Map<string, DiffMarkInfo>, out: NonTextChange[] = []): NonTextChange[] {
  for (const e of entries) {
    if (marks.get(e.key)?.nonText && e.before && e.after) out.push({ key: e.key, before: e.before, after: e.after });
    collectNonText(e.children, marks, out);
  }
  return out;
}

function NonTextDialog({ change, onClose }: { change: NonTextChange; onClose: () => void }) {
  const { t } = useTranslation();
  const before = useMemo(() => [change.before], [change]);
  const after = useMemo(() => [change.after], [change]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("versions.preview.nonTextChanged")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="min-w-0">
            <h3 className="mb-1 text-xs text-muted-foreground">{t("versions.preview.before")}</h3>
            <DiffEditor blocks={before} marks={NO_MARKS} />
          </section>
          <section className="min-w-0">
            <h3 className="mb-1 text-xs text-muted-foreground">{t("versions.preview.after")}</h3>
            <DiffEditor blocks={after} marks={NO_MARKS} />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 版本預覽（spec §8.4）：渲染在 `NoteEditor` 的 `previewSlot`（`overflow-y-auto` 的捲動容器）裡。
 * 單欄＝一顆唯讀編輯器渲染 `renderDiff`；並排＝左右兩顆，**兩欄都不是捲動容器**，一起在 slot 那一個捲動容器裡同步捲動。
 *
 * ⚠ 所有衍生值都 `useMemo`（gate r1 I-5）：`DiffEditor` 以 `blocks` 身分決定要不要重建編輯器，而本元件會因清單去抖動
 * invalidate、視窗聚焦重抓、ResizeObserver、context 變動頻繁 re-render——任何一層沒記憶化都會讓預覽每次跳回頂端重建。
 * ⚠ return 一律是 `ref` 那層 wrapper（gate r2 M-1）：`useContainerWidth` 只在掛載時裝量尺，loading 早退會讓量尺永遠沒掛上。
 */
export function VersionPreview({ doc, forceSingle = false }: { doc: Y.Doc; forceSingle?: boolean }) {
  const { t } = useTranslation();
  const { noteId, preview, compareRight, splitMode, onlyChanges, stopPreview, setCompareRight, reportPreviewWide } = useVersions();
  const ref = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(ref);

  // 比較對象＝左右一對（spec §8.4【rev 10】）：左＝預覽的那一版、右＝compareRight（"current" 時不抓快照、讀活文件的 fork）。
  const list = useVersionList(noteId ?? "", preview !== null);
  const rightTarget = compareRight === "current" ? null : compareRight;
  const left = useVersionSnapshot(noteId ?? "", preview);
  const right = useVersionSnapshot(noteId ?? "", rightTarget);

  // 左邊不符 → 離開預覽（原行為）；右邊不符 → 右邊回到「目前狀態」、同一句 toast、不離開預覽。
  // 兩邊的 useVersionSnapshot 都已 invalidate 清單。
  const leftGone = left.error instanceof VersionSnapshotMismatch;
  const rightGone = rightTarget !== null && right.error instanceof VersionSnapshotMismatch;
  // 讀取失敗（非 mismatch）→ 預覽區顯示通用錯誤，不停在「正在載入」（fix round 1 M-1）。清單只看「沒有任何資料」：
  // 已有資料時的背景重抓失敗不打斷預覽。
  const failed = (left.isError && !leftGone) || (rightTarget !== null && right.isError && !rightGone) || (list.isError && list.data === undefined);
  useEffect(() => {
    if (!leftGone) return;
    toast({ title: t("versions.preview.gone") });
    stopPreview();
  }, [leftGone, stopPreview, t]);
  useEffect(() => {
    if (!rightGone) return;
    toast({ title: t("versions.preview.gone") });
    setCompareRight("current");
  }, [rightGone, setCompareRight, t]);

  const leftBlocks = useMemo(() => (left.data ? ydocBytesToBlocks(left.data) : null), [left.data]);
  const rightBlocks = useMemo(() => (right.data ? ydocBytesToBlocks(right.data) : null), [right.data]);
  const rightIsCurrent = compareRight === "current";
  const [a, b] = useMemo<[DiffBlock[] | null, DiffBlock[] | null]>(() => {
    // diff 方向固定左→右（左＝a、右＝b）；選到左新右舊就是反向 diff，不自動換邊。
    // 「目前狀態」：讀活文件的 fork，在切換當下（右邊或預覽的那一版換了）讀一次、不訂閱活文件（預覽是快照比較）。
    // 依 `preview` 重讀：面板換一版時「目前狀態」也重新取樣。
    if (rightIsCurrent) return [leftBlocks, preview ? forkLiveBlocks(doc) : null];
    return [leftBlocks, rightBlocks];
  }, [rightIsCurrent, leftBlocks, rightBlocks, preview, doc]);
  const entries = useMemo(() => (a && b ? diffBlocks(a, b) : null), [a, b]);
  const collapsedText = useCallback((n: number) => t("versions.preview.collapsed", { count: n }), [t]);
  const single = useMemo(() => (entries ? renderDiff(entries, { onlyChanges, collapsedText }) : null), [entries, onlyChanges, collapsedText]);
  const sides = useMemo(() => (entries ? sideBySideMarks(entries) : null), [entries]);
  const nonText = useMemo(() => (entries && single ? collectNonText(entries, single.marks) : []), [entries, single]);

  // 並排只在預覽區夠寬時存在（final §14-6）：窄時一律單欄，使用者選過的「並排」留在 splitMode、變寬後恢復。
  // 與 controller 的 `splitActive`（`previewWide && splitMode !== "single"`）同一條。
  const wide = !forceSingle && width >= SPLIT_MIN_WIDTH;
  const split = wide && splitMode !== "single";
  // 回報寬度判定給橫幅／整頁（final M-1、§14-6）：寬度只有本元件量得到。卸載時歸零。
  // useLayoutEffect（final fix 2 N-A）：寬版第一次進預覽時，在瀏覽器繪製前就讓橫幅拿到 previewWide，避免閃一格沒有並排鈕【推】
  // （jsdom 分不出 useEffect／useLayoutEffect：換回 useEffect 測試照樣綠，突變 R6；沒有測試守著）。
  useLayoutEffect(() => {
    reportPreviewWide(wide);
    return () => reportPreviewWide(false);
  }, [wide, reportPreviewWide]);

  // 非文字 changed 的「看前後」鈕：疊在 wrapper 上，top 對齊該區塊（右欄／單欄那一顆）。按鈕集合、版面、寬度變了才重量；
  // 子層 DiffEditor 的 DOM 在它自己的 layout effect 之前就已掛上（Step 1 探針），所以這裡量得到。
  // 已知限制：區塊內圖片之後才載入而撐高時不重量（jsdom 量不到座標，無測試）。
  const [tops, setTops] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const wrap = ref.current;
    if (!wrap) return;
    const base = wrap.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    for (const c of nonText) {
      const els = wrap.querySelectorAll(`.bn-block-outer[data-id="${CSS.escape(c.key)}"]`);
      const el = els[els.length - 1];
      if (el) next[c.key] = el.getBoundingClientRect().top - base;
    }
    setTops((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  }, [nonText, split, width]);
  const [opened, setOpened] = useState<NonTextChange | null>(null);
  // 換一版預覽（或換右邊）：render 期間重設「看前後」對話框與鈕位（fix round 1 M-4；同 useVersionsController 的「依 props 重設 state」形）。
  const seqNow = `${preview?.id ?? ""}|${rightTarget?.id ?? "current"}`;
  const [forSeq, setForSeq] = useState(seqNow);
  if (forSeq !== seqNow) {
    setForSeq(seqNow);
    setOpened(null);
    setTops({});
  }

  // 並排時兩個比較對象下拉就是兩欄的標頭（rev 10，取代原本純文字的 vN 標籤，位置不變）；橫幅那時不放下拉。
  // 標頭列只看 `preview && split`，**不跟著 body 的載入／失敗分支消失**（review I-1）：否則右快照讀取失敗時沒有任何控制項能把右邊換掉，
  // 在欄標頭選一個未快取的版本時觸發鈕會在選單關閉前卸載、焦點掉到 body。標頭列與兩欄共用同一組 grid 欄寬與 gap，左右對齊。
  const splitHead =
    preview && split ? (
      <div data-testid="diff-split-head" className="grid grid-cols-2 gap-4">
        <div className="min-w-0 px-4 pb-1 text-xs">
          <ComparePicker side="left" />
        </div>
        <div className="min-w-0 border-l border-border px-4 pb-1 text-xs">
          <ComparePicker side="right" />
        </div>
      </div>
    ) : null;

  let body: ReactNode = null;
  if (preview) {
    if (failed) {
      body = (
        <p role="alert" className="text-sm text-muted-foreground">
          {t("errors.fallback")}
        </p>
      );
    } else if (!a || !b || !single || !sides) {
      body = <p className="text-sm text-muted-foreground">{t("versions.preview.loading")}</p>;
    } else if (split) {
      body = (
        <div data-testid="diff-split" className="kb-diff-split grid min-h-0 flex-1 grid-cols-2 gap-4">
          <section className="min-w-0">
            <DiffEditor blocks={a} marks={sides.left} />
          </section>
          <section className="min-w-0 border-l border-border">
            <DiffEditor blocks={b} marks={sides.right} />
          </section>
        </div>
      );
    } else {
      body = (
        <div data-testid="diff-single" className={cn(ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING)}>
          <DiffEditor blocks={single.blocks} marks={single.marks} testId="diff-single-editor" />
        </div>
      );
    }
  }

  return (
    <div ref={ref} className="relative flex min-h-full flex-col p-4">
      {splitHead}
      {body}
      {nonText.map((c) => (
        <Button key={c.key} type="button" variant="outline" size="sm" className="absolute h-7 bg-background text-xs" style={{ top: tops[c.key] ?? 0, right: "1rem" }} onClick={() => setOpened(c)}>
          {t("versions.preview.nonTextChanged")}
        </Button>
      ))}
      {opened && <NonTextDialog change={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}
