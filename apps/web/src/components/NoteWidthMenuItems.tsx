import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NOTE_WIDTHS } from "@knotebook/shared";
import { useWidePointer } from "@/lib/wide-pointer";
import { toNoteWidth, useNoteWidth } from "@/components/note-width";
import {
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronDown, NoteWidthIcon } from "@/components/ui/icons";

/** 頁首 ⋮ 交給寬度項的控制：展開狀態由選單持有（Esc 先收合要看得到它）。 */
export interface NoteWidthItemsControl {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** 寬窄判準翻轉時呼叫一次；呼叫端關整個選單並重設展開狀態。 */
  onModeChange: () => void;
}

/** 寬度項的 radio 列樣式照 `DropdownMenuCheckboxItem`（RadioItem 是不帶樣式的最小包裝）。 */
const WIDTH_RADIO_ROW =
  "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none " +
  "transition-colors focus:bg-accent focus:text-accent-foreground";

/**
 * 頁首 ⋮ 的「寬度」：標準／寬／全寬三選一（站內、每篇各自記，見 `note-width.ts`）。頁首寬度鈕在頁首太窄時收起，
 * 這一項讓任何寬度都設得到。兩種形（判準同 `GroupTransferMenuItems`，`useWidePointer`）：
 * - 寬且可 hover：Radix 巢狀子選單；Esc 只收這一層、焦點回「寬度」項。
 * - 窄或觸控：點「寬度」就地展開三個 radio 項，選了選單不關；展開狀態由頁首 `NoteMenu` 持有（Esc 先收合，見 `onEscapeKeyDown`）。
 * `useNoteWidth` 只在這裡呼叫，所以選單內容掛著（開著）才訂閱寬度 store。
 */
export function NoteWidthMenuItems({ noteId, expanded, onExpandedChange, onModeChange }: NoteWidthItemsControl & { noteId: string }) {
  const { t } = useTranslation();
  const [width, setWidth] = useNoteWidth(noteId);
  const wide = useWidePointer();
  const prevWide = useRef(wide);
  useEffect(() => {
    if (prevWide.current === wide) return;
    prevWide.current = wide;
    onModeChange();
  }, [wide, onModeChange]);
  const [subOpen, setSubOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  // 就地展開收合（尤其 Esc）後，焦點原本在被卸載的 radio 項上 -> 還給「寬度」項，鍵盤不掉出選單。
  const prevExpanded = useRef(expanded);
  useEffect(() => {
    const prev = prevExpanded.current;
    prevExpanded.current = expanded;
    if (prev && !expanded && !document.activeElement?.closest('[role="menuitem"]')) triggerRef.current?.focus();
  }, [expanded]);
  const label = t("note.width.label");
  const radios = NOTE_WIDTHS.map((w) => (
    <DropdownMenuRadioItem
      key={w}
      value={w}
      className={WIDTH_RADIO_ROW}
      // 就地形選了不關選單；子選單形走 Radix 預設（選了關整個選單）。
      onSelect={wide ? undefined : (event) => event.preventDefault()}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuItemIndicator>
      </span>
      {t(`note.width.${w}`)}
    </DropdownMenuRadioItem>
  ));
  if (wide) {
    return (
      <DropdownMenuSub open={subOpen} onOpenChange={setSubOpen}>
        <DropdownMenuSubTrigger ref={triggerRef}>
          <NoteWidthIcon width={width} className="mr-2 h-4 w-4" />
          {label}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setSubOpen(false);
            triggerRef.current?.focus();
          }}
        >
          <DropdownMenuRadioGroup value={width} onValueChange={(v) => setWidth(toNoteWidth(v))}>
            {radios}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }
  return (
    <>
      <DropdownMenuItem
        ref={triggerRef}
        aria-expanded={expanded}
        onSelect={(event) => {
          event.preventDefault(); // 選單保持開著，只切換展開
          onExpandedChange(!expanded);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && !expanded) {
            event.preventDefault();
            onExpandedChange(true);
          } else if (event.key === "ArrowLeft" && expanded) {
            event.preventDefault();
            onExpandedChange(false);
          }
        }}
      >
        <NoteWidthIcon width={width} className="mr-2 h-4 w-4" />
        {label}
        <ChevronDown className={"ml-auto h-4 w-4 transition-transform" + (expanded ? " rotate-180" : "")} />
      </DropdownMenuItem>
      {expanded && (
        <DropdownMenuRadioGroup
          aria-label={label}
          value={width}
          onValueChange={(v) => setWidth(toNoteWidth(v))}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              onExpandedChange(false);
            }
          }}
        >
          {radios}
        </DropdownMenuRadioGroup>
      )}
    </>
  );
}
