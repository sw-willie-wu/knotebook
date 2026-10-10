import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as Y from "yjs";
import type { NoteDto, VersionDto } from "@knotebook/shared";
import { useVersionList } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { useVersions } from "@/lib/versions-context";
import { ComparePicker } from "./ComparePicker";
import { VersionPreview } from "./VersionPreview";
import { OnlyChangesToggle } from "./PreviewBanner";
import { VersionRowContent, VersionRowMenu } from "./VersionsPanel";
import { currentSubtitle, editorsText, formatVersionTime } from "./version-labels";
import { useApplyFlow } from "./use-apply-flow";

/**
 * 窄視窗（`<md`）的版本歷史：全螢幕 Radix Dialog、不改網址（spec §8.3）。
 * 步一＝清單（「‹ 返回 · 版本歷史」、最後編輯、目前狀態、清單、底部「儲存當前版本」）；
 * 步二＝預覽（「‹ 清單 · vN · 時間」、單欄 diff、底部「‹ 上一版 ｜ 套用 vN ｜ 下一版 ›」）。步數就是 `preview` 是否為 null。
 * 底部「較舊的版本」＝seq 較小的下一筆、「較新的版本」＝較大的那筆（文案刻意不用「前一版」，免得與比較對象撞名）；
 * 到頭就 disabled（較舊那側還有下一頁時先載，載入中 disabled）。
 * 整頁不掛 `PreviewBanner`，步二頁首第二列自己給它的控制項：比較對象一對下拉（`ComparePicker`，左 → 右；spec §8.3／§8.4【rev 10】）、
 * 「只看差異」——兩者都讀 controller 的狀態。只有並排／單欄不提供（`forceSingle`），所以下拉一律放列 2。
 * 焦點：受控 Dialog 沒有 Trigger，Radix 關閉時不會還原焦點——掛載當下記住 `document.activeElement`，關閉時手動還（同 `GroupNameDialog`）。
 * 記到的元素已不在 DOM（從頁首 ⋮ 開：記到的是選單項，選單關掉就卸載）→ 退回 `returnFocusRef`（NotePage 交下來的 ⋮ 觸發鈕，final I-1）。
 * 320 px：步二頁首第二列帶 `flex-wrap`，放不下就換行（依 class 推論；jsdom 量不到版面，真瀏覽器量測留 e2e）。
 * Esc：步二＝回清單、步一＝關整頁，兩者都 `preventDefault`（NotePage 的預覽 Esc 以 `defaultPrevented` 讓路）。
 */
export function VersionsSheet({ doc, lastEdited, returnFocusRef }: { doc: Y.Doc; lastEdited: NoteDto["lastEdited"]; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const { t, i18n } = useTranslation();
  const { noteId, preview, startPreview, stopPreview, close, openSave } = useVersions();
  // body 不算「可還的元素」（final fix 2 M-A）：當成沒記到，關閉時走 returnFocusRef（⋮）。
  const [returnFocus] = useState(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  const id = noteId ?? "";
  const list = useVersionList(id, true);
  const { requestApply } = useApplyFlow(id);
  const rows = list.data?.pages.flatMap((p) => p.versions) ?? [];
  const current = list.data?.pages[0]?.current;
  const latestSeq = rows[0]?.seq ?? null;
  const index = preview ? rows.findIndex((r) => r.seq === preview.seq) : -1;
  const row: VersionDto | undefined = index >= 0 ? rows[index] : undefined;
  const older = index >= 0 ? rows[index + 1] : undefined;
  const newer = index > 0 ? rows[index - 1] : undefined;
  // 底部「較舊／較新的版本」只換左邊（同面板點列；右邊保持，rev 10）。
  const go = (v: VersionDto) => startPreview({ seq: v.seq, id: v.id });

  const shut = () => {
    stopPreview();
    close();
  };

  const lastEditedText = (() => {
    if (!lastEdited) return null;
    const handle = lastEdited.byHandle === "" ? t("note.lastEditedDeletedUser") : lastEdited.byHandle;
    const who = lastEdited.agentLabel === null ? handle : `${handle} (${lastEdited.agentLabel})`;
    return t("note.lastEdited", { who, when: new Date(lastEdited.at).toLocaleDateString(i18n.language) });
  })();

  const renderList = () => (
    <>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button type="button" variant="ghost" size="sm" aria-label={t("versions.sheet.back")} onClick={shut}>
          <span aria-hidden="true">‹</span> {t("versions.sheet.back")}
        </Button>
        <h2 className="text-sm font-semibold">{t("versions.title")}</h2>
      </header>
      <p data-testid="sheet-last-edited" className="px-4 pt-3 text-xs text-muted-foreground">
        {lastEditedText}
      </p>
      <div data-testid="sheet-current" className="mx-4 mt-3 border-b border-dashed border-border pb-2">
        <p className="text-sm font-medium">{t("versions.currentLabel")}</p>
        {current && <p className="text-xs text-muted-foreground">{currentSubtitle(t, current, latestSeq)}</p>}
        {current && !current.autoEnabled && <p className="text-xs text-muted-foreground">{t("versions.autoOff")}</p>}
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {rows.map((version) => {
          const isBase = current?.baseSeq === version.seq;
          return (
            <li key={version.id} className="flex items-start gap-1">
              <button type="button" onClick={() => go(version)} className="flex min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent/60">
                <VersionRowContent version={version} isBase={isBase} />
              </button>
              <VersionRowMenu version={version} isBase={isBase} onApply={(v) => void requestApply(v)} />
            </li>
          );
        })}
        {list.hasNextPage && (
          <li>
            <Button type="button" variant="ghost" size="sm" className="w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t("versions.loadMore")}
            </Button>
          </li>
        )}
      </ul>
      <footer data-testid="sheet-footer" className="border-t border-border p-3">
        <Button type="button" variant="outline" className="w-full" disabled={!current || !(current.dirty || current.baseSeq === null)} onClick={() => openSave()}>
          {t("versions.save")}
        </Button>
      </footer>
    </>
  );

  const renderPreview = (seq: number) => (
    <>
      <header className="space-y-1 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={stopPreview}>
            <span aria-hidden="true">‹</span> {t("versions.sheet.backToList")} · v{seq}
          </Button>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {row && `${formatVersionTime(row.createdAt, i18n.language)} · ${editorsText(t, row.editors)}`}
          </span>
        </div>
        <div data-testid="sheet-compare-row" className="flex flex-wrap items-center gap-1 text-xs">
          <ComparePicker side="left" />
          <span aria-hidden="true" className="text-muted-foreground">
            →
          </span>
          <ComparePicker side="right" />
          <OnlyChangesToggle />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <VersionPreview doc={doc} forceSingle />
      </div>
      <footer data-testid="sheet-footer" className="grid grid-cols-3 gap-2 border-t border-border p-3">
        <Button type="button" variant="outline" disabled={older ? false : !list.hasNextPage || list.isFetchingNextPage} onClick={() => (older ? go(older) : void list.fetchNextPage())}>
          {t("versions.sheet.prev")}
        </Button>
        <Button type="button" variant="brandDeep" disabled={!row} onClick={() => row && void requestApply(row)}>
          {t("versions.applySeq", { seq })}
        </Button>
        <Button type="button" variant="outline" disabled={!newer} onClick={() => newer && go(newer)}>
          {t("versions.sheet.next")}
        </Button>
      </footer>
    </>
  );

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && shut()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col bg-card"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            const target = returnFocus?.isConnected ? returnFocus : returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (preview === null) return;
            event.preventDefault();
            stopPreview();
          }}
        >
          <DialogPrimitive.Title className="sr-only">{t("versions.title")}</DialogPrimitive.Title>
          {preview === null ? renderList() : renderPreview(preview.seq)}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
