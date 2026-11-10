import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type FolderDto, type GroupDto, type NoteDto } from "@knotebook/shared";
import { folderErrorMessage, invalidateFolderRelated, isFolderNotFound, useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { useConfirmNoteStillPersonal, useCopyNote, useMoveNoteToGroup } from "@/api/note-move";
import { usePublicLink } from "@/api/public-link";
import { useShares } from "@/api/shares";
import {
  buildDestinationLevel,
  destinationPathLabel,
  isEmptyDestination,
  isSameSpace,
  livePath,
  noteDestSource,
  type DestItem,
  type DestPathStep,
  type DestSource,
  type DestTarget,
  type Translate,
} from "@/components/sidebar/destination-level";
import { useWidePointer } from "@/lib/wide-pointer";
import { destinationItemIcon } from "@/components/sidebar/destination-icon";
import { indexFolders, type FolderIndex } from "@/components/sidebar/folder-index";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronDown, ChevronRight, Copy, FolderInput } from "@/components/ui/icons";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";

export type GroupTransferKind = "move" | "copy";

/** 使用者在逐層清單選的資料夾：`path`＝`destinationPathLabel` 的完整路徑（「我的筆記 › A」「研發組 › A › B」），確認框用。 */
export type FolderRef = { id: string; path: string };

/**
 * 目標（資料夾 spec §6.11.2、§6.11.3）：
 * - `group`：移入群組／複製到群組，`folder` 不給＝群組根層；
 * - `inPlace`：群組筆記「建立副本」（落在來源同一資料夾）；
 * - `duplicate`：自己的個人筆記「建立副本」（落在來源同一資料夾）；
 * - `personal`：複製到我的筆記，`folder` 不給＝根層（共享筆記自己的共享放置不跟著）。
 */
export type TransferTarget =
  | { type: "group"; group: GroupDto; folder?: FolderRef }
  | { type: "inPlace"; group: GroupDto }
  | { type: "duplicate" }
  | { type: "personal"; folder?: FolderRef };

/** 確認框要的選定結果（`GroupTransferDialog`）。 */
export interface GroupTransferPick {
  kind: GroupTransferKind;
  target: TransferTarget;
}

/**
 * ⋮ 子選單選定的目的地（非 drill 項）。groups／index 在 `GroupTransferMenuItems` 裡算（只在選單開著時掛載），隨 pick 傳出：
 * `NoteMenuCore` 頂層不訂閱 `useGroups`／`useFolders`（總管裁定 2026-10-29 M1）。
 */
export interface DestinationPick {
  kind: GroupTransferKind;
  target: DestTarget;
  groups: readonly GroupDto[];
  index: FolderIndex;
}

/** 移動、複製各一份所在層（spec §6.11.4）；`NoteMenuCore` 持有，選單關閉時回到這個值。 */
export type DestPaths = Readonly<Record<GroupTransferKind, readonly DestPathStep[]>>;
const NO_STEPS: readonly DestPathStep[] = [];
export const EMPTY_DEST_PATHS: DestPaths = { move: NO_STEPS, copy: NO_STEPS };

const NO_GROUPS: readonly GroupDto[] = [];
const NO_FOLDERS: readonly FolderDto[] = [];

function folderRef(target: Extract<DestTarget, { kind: "place" }>, index: FolderIndex, t: Translate): FolderRef | undefined {
  return target.folder === null ? undefined : { id: target.folder.id, path: destinationPathLabel(target.space, target.folder, index, t) };
}

/**
 * 同空間移動（spec §6.11.3）：移動、且目的地與這篇的移動來源（`noteDestSource`）上半部同一空間——自己的個人筆記放進我的筆記、
 * 群組筆記放進本群組、共享筆記放進自己的共享私人資料夾；判準與選取模式共用 `isSameSpace`。呼叫端不跳確認、直接 PUT。
 */
export function isSameSpaceMove(note: NoteDto, pick: DestinationPick): boolean {
  return pick.kind === "move" && pick.target.kind === "place" && isSameSpace(pick.target, noteDestSource(note, "move", pick.groups));
}

/**
 * 子選單選定的 `DestTarget` → 確認框目標（spec §6.11.2、§6.11.3）。**null＝同空間移動，或到不了的分支（找不到群組）**：
 * 呼叫端用 `isSameSpaceMove` 分辨——同空間移動直接 `placeNoteWithUndo`、不跳確認（個人筆記放進我的筆記、群組筆記放進本群組、
 * 共享筆記放進自己的共享私人資料夾），其餘什麼都不做。
 * - 「建立副本」：個人筆記＝`duplicate`；群組筆記＝`inPlace`（本群組，落在來源同一資料夾，見 `copyRequest`）。
 * - 移動到其他群組（只有自己的個人筆記會有）＝`group`，選了資料夾帶完整路徑；複製到我的筆記＝`personal`、到群組＝`group`。
 * groups 與 `DestSpace` 都出自同一份 `pick.groups`（`noteDestSource`），找不到群組的分支到不了，保守回 null。
 */
export function transferTargetOf(note: NoteDto, pick: DestinationPick, t: Translate): TransferTarget | null {
  const { target, groups, index } = pick;
  const findGroup = (groupId: string | null) => groups.find((group) => group.id === groupId);
  if (target.kind === "makeCopy") {
    if (note.groupId === null) return { type: "duplicate" };
    const own = findGroup(note.groupId);
    return own === undefined ? null : { type: "inPlace", group: own };
  }
  const folder = folderRef(target, index, t);
  const { space } = target;
  if (isSameSpaceMove(note, pick)) return null;
  if (space.kind === "personal") return folder === undefined ? { type: "personal" } : { type: "personal", folder };
  if (space.kind !== "group") return null;
  const group = findGroup(space.groupId);
  if (group === undefined) return null;
  return folder === undefined ? { type: "group", group } : { type: "group", group, folder };
}

/** 就地展開形（窄／觸控）一組（移動或複製）目前這一層與它的換層動作。寬形（層疊）不用 path，見 `CascadeRoot`。 */
interface LevelNav {
  items: DestItem[];
  /** NoteMenuCore 持有的 path（物件同一性＝沒換層）。 */
  path: readonly DestPathStep[];
  /** 第二層起（「返回」恆第一項）；不看 path.length（見 `livePath`）。 */
  nested: boolean;
  drill: (step: DestPathStep) => void;
  back: () => void;
  pick: (target: DestTarget) => void;
}

/**
 * 就地展開形的層內容（spec §6.11.1、§6.11.4、§6.16）：每個 `DestItem` 一個選單項，分隔線＝`DropdownMenuSeparator`。
 * 只在展開時掛載，期間持續存在（**不以 path 當 key**）；換層後（掛載後 path 改變）把焦點交給新層第一個未停用的項目
 * （第二層起即「返回」；總管裁定 2026-10-29 m1、m1-1、M3）。
 * 返回項前導 `ChevronLeft` 圖示（`aria-hidden`）、可及名稱是「返回」；帶 `>` 的項目可及名稱＝「{{name}}，開啟下一層」。
 */
function DestinationLevelItems({
  level,
  itemClassName,
  onLeft,
}: {
  level: LevelNav;
  itemClassName?: string;
  /** 項目上的 ArrowLeft（第二層起回上一層、第一層收合）。 */
  onLeft: () => void;
}) {
  const { items, path } = level;
  const firstRef = useRef<HTMLDivElement>(null);
  const prevPath = useRef(path);
  useLayoutEffect(() => {
    if (prevPath.current === path) return;
    prevPath.current = path;
    firstRef.current?.focus();
  }, [path]);
  const firstEnabled = items.findIndex((item) => item.kind === "back" || (item.kind !== "separator" && item.disabled === null));
  return (
    <>
      {items.map((item, position) => {
        if (item.kind === "separator") return <DropdownMenuSeparator key={item.key} />;
        const drill = item.kind === "folder" || item.kind === "space" ? item.drill : null;
        const Icon = destinationItemIcon(item);
        return (
          <DropdownMenuItem
            key={item.key}
            ref={position === firstEnabled ? firstRef : undefined}
            className={itemClassName}
            disabled={item.kind !== "back" && item.disabled !== null}
            textValue={item.label}
            aria-label={drill === null ? undefined : item.accessibleName}
            onSelect={(event) => {
              if (item.kind === "back") {
                event.preventDefault(); // 選單不關，回上一層
                level.back();
              } else if (drill !== null) {
                event.preventDefault(); // 選單不關，換成下一層
                level.drill(drill);
              } else {
                level.pick(item.target);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" && drill !== null) {
                event.preventDefault();
                level.drill(drill);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                onLeft();
              }
            }}
          >
            {Icon !== null && <Icon aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />}
            <span className="truncate">{item.label}</span>
            {drill !== null && <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0" />}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** 觸發項前的圖示：與 `NoteMenu` 其他項同一組 class（`mr-2 h-4 w-4`），兩種形態共用。 */
function TransferIcon({ kind }: { kind: GroupTransferKind }) {
  return kind === "move" ? <FolderInput className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />;
}

/** 就地展開形的一組：觸發項（Enter／Space／右鍵展開或收合，左鍵收合）＋縮排的目前這一層（同一個 menu 的一般項，上下鍵照常漫遊）。
 * 點 `>` 項＝原地換成下一層（觸發項不動、「返回」成為第一個縮排項）；第二層起 ArrowLeft 回上一層、第一層 ArrowLeft 收合。
 * 收合（再點觸發項、第一層 ArrowLeft）時呼叫端一併重設 path；Esc 的收合由 `NoteMenu` 的 `onEscapeKeyDown` 接（見 `GroupTransferMenuItems`）。 */
function GroupInline({
  kind,
  label,
  level,
  open,
  onOpenChange,
  testId,
  triggerRef,
}: {
  kind: GroupTransferKind;
  label: string;
  level: LevelNav;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  triggerRef: (el: HTMLDivElement | null) => void;
}) {
  return (
    <>
      <DropdownMenuItem
        ref={triggerRef}
        data-testid={testId}
        aria-expanded={open}
        onSelect={(event) => {
          event.preventDefault(); // 選單保持開著，只切換展開
          onOpenChange(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && !open) {
            event.preventDefault();
            onOpenChange(true);
          } else if (event.key === "ArrowLeft" && open) {
            event.preventDefault();
            onOpenChange(false);
          }
        }}
      >
        <TransferIcon kind={kind} />
        {label}
        <ChevronDown className={"ml-auto h-4 w-4 transition-transform" + (open ? " rotate-180" : "")} />
      </DropdownMenuItem>
      {open && (
        <DropdownMenuGroup aria-label={label}>
          <DestinationLevelItems
            level={level}
            itemClassName="pl-6"
            onLeft={() => (level.nested ? level.back() : onOpenChange(false))}
          />
        </DropdownMenuGroup>
      )}
    </>
  );
}

/** 層疊每一層 `SubContent` 的 class（高度跟著 Radix 量到的可用高度、窄視窗不貼邊）。 */
const CASCADE_CONTENT_CLASS =
  "max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] max-w-[min(18rem,calc(100vw-2rem))] overflow-y-auto";

/** 層疊形各層共用：來源、資料夾索引、選定（非 `>` 項）回報。 */
interface CascadeProps {
  source: DestSource;
  index: FolderIndex;
  onPick: (target: DestTarget) => void;
}

/** 有下一層的資料夾／空間項（`drill` 非 null）＝層疊的 SubTrigger。 */
type DrillItem = Extract<DestItem, { kind: "folder" | "space" }> & { drill: DestPathStep };

/**
 * 層疊形（寬且可 hover，spec F23、§6.11.4）的「移動到…／複製到…」那一層：受控 Radix `Sub`，內容是第一層（`CascadeItems`）。
 * - Esc：Radix 的 SubContent 對 Esc 呼叫的是 root 的 onClose（整個選單關掉，實測），所以自己接——`preventDefault`、只收這一層、
 *   焦點回觸發項（總管裁定 ②；各層的 `CascadeSub` 同法）。
 * - ArrowLeft 不攔：Radix 內建在 `SubContent` 上收起該層、焦點回觸發項。
 * - `SubContent` 走 Portal（見 `ui/dropdown-menu.tsx`），不被父層 `overflow-hidden` 裁掉，貼近視窗邊緣時 Radix 自動翻邊。
 */
function CascadeRoot({
  kind,
  label,
  testId,
  source,
  index,
  onPick,
}: CascadeProps & { kind: GroupTransferKind; label: string; testId: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 焦點所在的項目被卸載（資料夾晚到時一般項換成 SubTrigger、資料夾被刪連子選單一起消失）時焦點會掉到 body，鍵盤就出不了選單：
  // 每次 render 後檢查，掉了就交給這一層的內容（Radix 再交給第一個可聚焦項）。必須是 useEffect：useLayoutEffect 時 Radix 的
  // collection 還留著剛卸載的項目，focusFirst 會在 null 上呼叫 focus（審查三引擎實測）。子層 `CascadeSub` 同法，子層的 effect 先跑。
  useEffect(() => {
    if (open && document.activeElement === document.body) contentRef.current?.focus();
  });
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger ref={triggerRef} data-testid={testId}>
        <TransferIcon kind={kind} />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        ref={contentRef}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }}
        className={CASCADE_CONTENT_CLASS}
      >
        <CascadeItems source={source} path={NO_STEPS} index={index} onPick={onPick} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * 層疊的一層：`buildDestinationLevel` 去掉「返回」（spec §6.11.1：寬形沒有返回，往旁層疊本身就是回上一層的路）。
 * 有下一層的項目＝`CascadeSub`；其餘＝一般項（前導圖示、反灰、選定即回報）。
 */
function CascadeItems({ source, path, index, onPick }: CascadeProps & { path: readonly DestPathStep[] }) {
  const { t } = useTranslation();
  const items = buildDestinationLevel({ source, path, index, t }).filter((item) => item.kind !== "back");
  return (
    <>
      {items.map((item) => {
        if (item.kind === "separator") return <DropdownMenuSeparator key={item.key} />;
        if ((item.kind === "folder" || item.kind === "space") && item.drill !== null) {
          return <CascadeSub key={item.key} item={{ ...item, drill: item.drill }} source={source} path={path} index={index} onPick={onPick} />;
        }
        const Icon = destinationItemIcon(item);
        return (
          <DropdownMenuItem key={item.key} disabled={item.disabled !== null} textValue={item.label} onSelect={() => onPick(item.target)}>
            {Icon !== null && <Icon aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />}
            <span className="truncate">{item.label}</span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/**
 * 層疊的下一層：受控 Radix `Sub`。觸發項不設 `aria-label`——可及名稱＝項目文字（資料夾或空間名），有子選單由 Radix 的
 * `aria-haspopup`／`aria-expanded` 表達（總管裁定 ③；窄形逐層的「，開啟下一層」不用在這裡）；右側箭頭是 `DropdownMenuSubTrigger`
 * 自帶的那一顆。Esc 同 `CascadeRoot`（只收這一層、焦點回這個觸發項）。內容只在打開時掛載（Radix `Presence`），遞迴不會預先展開整棵樹。
 */
function CascadeSub({ item, source, path, index, onPick }: CascadeProps & { item: DrillItem; path: readonly DestPathStep[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 焦點掉到 body 時交還給這一層（見 `CascadeRoot`；必須 useEffect）。
  useEffect(() => {
    if (open && document.activeElement === document.body) contentRef.current?.focus();
  });
  const Icon = destinationItemIcon(item);
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger ref={triggerRef} textValue={item.label}>
        {Icon !== null && <Icon aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />}
        <span className="truncate">{item.label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        ref={contentRef}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }}
        className={CASCADE_CONTENT_CLASS}
      >
        <CascadeItems source={source} path={[...path, item.drill]} index={index} onPick={onPick} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * ⋮ 選單的「移動到…」「複製到…」兩個子選單項（#216；資料夾 spec §6.11）。內容是逐層目的地清單（`buildDestinationLevel`，
 * 規則全在 `components/sidebar/destination-level.ts`），群組＝`useGroups()`、資料夾＝`useFolders()`：還沒到時先列不需要資料夾的項目
 * （群組不帶 `>`），到了再補。第一層為空（`isEmptyDestination`）的那一組整項不渲染（I2）。
 * 兩種形態（判準 `lib/wide-pointer.ts`）：寬且可 hover＝往旁層疊的 Radix 巢狀子選單（`CascadeRoot`）；窄或觸控＝就地展開逐層（`GroupInline`）。
 * 選單開著時跨過判準 → `onModeChange`，呼叫端關掉整個選單（spec §6.11.4；總管裁定 ④）。
 * 選定非 `>` 項只回報（`onPick`）：同空間移動或確認框由呼叫端決定（`transferTargetOf`）。
 */
export function GroupTransferMenuItems({
  note,
  onPick,
  expanded,
  onExpandedChange,
  paths,
  onPathChange,
  onModeChange,
}: {
  note: NoteDto;
  onPick: (pick: DestinationPick) => void;
  /** 就地展開形（窄／觸控）目前展開的是哪一組；狀態由 `NoteMenu` 持有，因為 Esc 要在 `DropdownMenuContent` 的
   * `onEscapeKeyDown` 裡先收合、不關整個選單（Radix 的 Esc 監聽在 document，從項目的 onKeyDown 擋不住）。層疊形不用它。 */
  expanded: GroupTransferKind | null;
  onExpandedChange: (kind: GroupTransferKind | null) => void;
  /** 就地展開形兩組各自的所在層（`NoteMenuCore` 持有，選單關閉時重設）。層疊形不用它。 */
  paths: DestPaths;
  onPathChange: (kind: GroupTransferKind, path: readonly DestPathStep[]) => void;
  /** 掛載後寬窄判準翻轉時呼叫一次（spec §6.11.4「選單開著時跨過判準」）；NoteMenuCore 收到就關整個選單並重設 expanded／paths。 */
  onModeChange: () => void;
}) {
  const { t } = useTranslation();
  const groupsQuery = useGroups();
  const foldersQuery = useFolders();
  const groups = groupsQuery.data ?? NO_GROUPS;
  const index = useMemo(() => indexFolders(foldersQuery.data ?? NO_FOLDERS), [foldersQuery.data]);
  // 窄視窗或觸控 -> 就地向下展開（手風琴）；寬且可 hover -> 往旁層疊（Willie 2026-10-08、2026-10-31；判準見 `lib/wide-pointer.ts`）。
  const wide = useWidePointer();
  const inline = !wide;
  // 掛載後判準翻轉（拖視窗寬度、外接滑鼠、平板轉向）-> 通知呼叫端關整個選單；掛載當下不呼叫。
  const prevWide = useRef(wide);
  useEffect(() => {
    if (prevWide.current === wide) return;
    prevWide.current = wide;
    onModeChange();
  }, [wide, onModeChange]);
  const triggers = useRef<Partial<Record<GroupTransferKind, HTMLDivElement | null>>>({});
  const prevExpanded = useRef<GroupTransferKind | null>(null);
  // 收合（尤其 Esc）後焦點原本在被卸載的縮排項上 -> 還給觸發項，鍵盤不掉出選單。
  useEffect(() => {
    const prev = prevExpanded.current;
    prevExpanded.current = expanded;
    if (prev !== null && expanded === null) {
      const el = triggers.current[prev];
      const active = document.activeElement;
      if (el && !(active && active.closest('[role="menuitem"]'))) el.focus();
    }
  }, [expanded]);
  const kinds = [
    { kind: "move" as const, label: t("note.menu.moveTo"), testId: "note-menu-move-to" },
    { kind: "copy" as const, label: t("note.menu.copyTo"), testId: "note-menu-copy-to" },
  ]
    .map((entry) => ({ ...entry, source: noteDestSource(note, entry.kind, groups) }))
    .filter((entry) => !isEmptyDestination(entry.source, index, t));
  const levelOf = (kind: GroupTransferKind, source: DestSource): LevelNav => {
    const path = paths[kind];
    const items = buildDestinationLevel({ source, path, index, t });
    return {
      items,
      path,
      nested: items[0]?.kind === "back",
      drill: (step) => onPathChange(kind, [...livePath(source, path, index, t), step]),
      back: () => onPathChange(kind, livePath(source, path, index, t).slice(0, -1)),
      pick: (target) => onPick({ kind, target, groups, index }),
    };
  };
  return (
    <>
      {kinds.map(({ kind, label, testId, source }) =>
        inline ? (
          <GroupInline
            key={kind}
            kind={kind}
            label={label}
            testId={testId}
            level={levelOf(kind, source)}
            open={expanded === kind}
            onOpenChange={(open) => {
              // 收合回第一層；展開另一組時，被收起的那一組也回第一層（同時只展開一組）。
              if (!open) onPathChange(kind, NO_STEPS);
              else if (expanded !== null && expanded !== kind) onPathChange(expanded, NO_STEPS);
              onExpandedChange(open ? kind : null);
            }}
            triggerRef={(el) => {
              triggers.current[kind] = el;
            }}
          />
        ) : (
          <CascadeRoot
            key={kind}
            kind={kind}
            label={label}
            testId={testId}
            source={source}
            index={index}
            onPick={(target) => onPick({ kind, target, groups, index })}
          />
        ),
      )}
    </>
  );
}

/**
 * 選定群組後的確認框（原行內確認的 Dialog 版，文案與規則不變）。PR1 交接的不變量：
 * - **移動**（`MoveDialog`）確認列出會失去存取的逐人分享對象、有 token 時說公開連結會關、恆說網址會變與擁有權移交；提交鈕
 *   `destructive`。**shares 與 public-link 兩支都成功之前提交鈕停用**（資料不明時文案會低報被移除的人）。
 *   shares／public-link 的查詢**只由 `MoveDialog` 發**（複製不需要，且在群組筆記／別人分享給我的筆記上會 403 重試）。
 * - 送出前檢查（`useConfirmNoteStillPersonal`）：重讀到已不是我能移動的個人筆記 -> 不送、發 `changedElsewhere` toast。
 *   ⚠ 那支 hook 每次 render 回傳新函式——只在送出 handler 裡直接呼叫，**不得**放進任何 effect 的 deps。
 * - 移動成功：hook 先寫 shares／public-link 再寫 `['note', id]`（順序契約在 `api/note-move.ts`），之後的頁面只讀回應的
 *   `role`／`permissions`，不假設搬完能編輯。
 * - **複製**（`CopyDialog`）確認「原筆記不變」，提交鈕 `outline`；成功 toast 附「前往副本」（altText 鍵 `share.move.openCopyAlt`）。
 * - 失敗一律 toast（`folderErrorMessage`，帶 `max`）並關框——選單已關，沒有別處可放行內訊息。送出中（含送出前檢查）鈕停用、
 *   框不可關閉，避免重送出第二份副本。
 * - 資料夾（資料夾 spec §5.7.6 n6）：「建立副本」（`duplicate`／`inPlace`）帶來源的 `folderId`（來自快取），收到 404
 *   `folder_not_found` → 不帶 `folderId` 重送一次、落在根層並換成 `copiedAtTopLevel` toast；使用者明選的資料夾（`group`／
 *   `personal` 的 `folder`）404 → 不重試、錯誤 toast。兩者都 `invalidateFolderRelated` 讓樹重抓。
 * - 關框後焦點回 `returnFocusRef`（呼叫端的 ⋮ 觸發鈕）：Radix 的還焦點靠 `DialogTrigger`，這裡沒有，會掉到 body。
 */
interface DialogShellProps {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  footer: ReactNode;
}

function DialogShell({ title, description, busy, onClose, returnFocusRef, children, footer }: DialogShellProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        dismissOnOutside={false}
        data-testid="group-transfer-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef?.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TransferDialogProps {
  note: NoteDto;
  target: TransferTarget;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function MoveDialog({ note, target, onClose, returnFocusRef }: TransferDialogProps) {
  const group = target.type === "group" ? target.group : null;
  const folder = target.type === "group" ? target.folder : undefined;
  // 目的地名稱：群組名；選了群組資料夾時換成完整路徑（spec §6.11.2）。
  const destination = folder?.path ?? group?.name ?? "";
  const { t, i18n } = useTranslation();
  const sharesQuery = useShares(note.id);
  const linkQuery = usePublicLink(note.id);
  const move = useMoveNoteToGroup(note.id);
  const confirmStillPersonal = useConfirmNoteStillPersonal(note.id);
  const [submitting, setSubmitting] = useState(false);

  const busy = submitting || move.isPending;
  const dataKnown = sharesQuery.isSuccess && linkQuery.isSuccess;
  const shares = sharesQuery.data ?? [];
  const token = linkQuery.data?.token ?? null;
  const names = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(
    shares.map((share) => share.displayName),
  );

  async function submit(): Promise<void> {
    setSubmitting(true);
    try {
      if (!(await confirmStillPersonal())) {
        toast({ title: t("share.move.changedElsewhere") });
        return;
      }
      if (group === null) return;
      await move.mutateAsync(folder === undefined ? { groupId: group.id } : { groupId: group.id, folderId: folder.id });
      toast({ title: t("share.move.movedToGroup", { group: destination }) });
    } catch (err) {
      toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  return (
    <DialogShell
      title={t("share.move.moveSubmit")}
      description={t("share.move.moveLead", { group: destination })}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={busy || !dataKnown} onClick={() => void submit()}>
            {t("share.move.moveSubmit")}
          </Button>
        </>
      }
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {shares.length > 0 && <li>{t("share.move.moveRemovesPeople", { count: shares.length, names })}</li>}
        {token && <li>{t("share.move.moveClosesPublicLink")}</li>}
        <li>{t("share.move.moveUrlChange")}</li>
        <li>{t("share.move.moveOwnership")}</li>
        <li>{t("share.move.moveClearsVersions")}</li>
      </ul>
    </DialogShell>
  );
}

type CopyInput = { groupId?: string; folderId?: string };

/**
 * `POST /copy` 的 body（根層一律不帶 `folderId`，spec §6.11.3）＋ n6 退回用的 body（只有「建立副本」且來源在資料夾裡才有）。
 * 「建立副本」落在來源同一資料夾；共享筆記複製到我的筆記不帶自己的共享放置（`note.folderId` 是呼叫者視角的放置）。
 */
function copyRequest(note: NoteDto, target: TransferTarget): { input: CopyInput; fallback: CopyInput | null } {
  const groupPart: CopyInput = target.type === "group" || target.type === "inPlace" ? { groupId: target.group.id } : {};
  if (target.type === "duplicate" || target.type === "inPlace") {
    if (note.folderId === null) return { input: groupPart, fallback: null };
    return { input: { ...groupPart, folderId: note.folderId }, fallback: groupPart };
  }
  return { input: target.folder === undefined ? groupPart : { ...groupPart, folderId: target.folder.id }, fallback: null };
}

function CopyDialog({ note, target, onClose, returnFocusRef }: TransferDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const copy = useCopyNote(note.id);
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || copy.isPending;
  // 「建立副本」（自己的個人筆記、群組筆記就地）確認框標題／按鈕同字；複製到我的筆記（含其中的資料夾）是「複製到我的筆記」。
  const submitLabel =
    target.type === "group"
      ? t("share.move.copySubmit")
      : target.type === "personal"
        ? t("share.move.copyPersonalSubmit")
        : t("share.move.copyHereSubmit");
  // 「會在「X」建立副本」：X＝群組名，選了資料夾時換成完整路徑（spec §6.11.3 n7）。
  const lead =
    target.type === "group"
      ? t("share.move.copyLead", { group: target.folder?.path ?? target.group.name })
      : target.type === "inPlace"
        ? t("share.move.copyLeadInPlace", { group: target.group.name })
        : target.type === "personal" && target.folder !== undefined
          ? t("share.move.copyLead", { group: target.folder.path })
          : t("share.move.copyLeadPersonal");
  const copiedTitle =
    target.type === "group" || target.type === "inPlace"
      ? t("share.move.copiedToGroup", { group: target.group.name })
      : t("share.move.copiedToPersonal");

  async function submit(): Promise<void> {
    setSubmitting(true);
    const request = copyRequest(note, target);
    try {
      let created: NoteDto;
      let atTopLevel = false;
      try {
        created = await copy.mutateAsync(request.input);
      } catch (err) {
        // n6：只有「建立副本」帶的快取 folderId 失效才自動退回根層重送一次；明選的資料夾不重試（往外丟）。
        if (request.fallback === null || !isFolderNotFound(err)) throw err;
        invalidateFolderRelated(queryClient);
        created = await copy.mutateAsync(request.fallback);
        atTopLevel = true;
      }
      toast({
        title: atTopLevel ? t("share.move.copiedAtTopLevel") : copiedTitle,
        action: {
          label: t("share.move.openCopy"),
          altText: t("share.move.openCopyAlt"),
          onClick: () => void navigate(canonicalNotePath(created)),
        },
      });
    } catch (err) {
      if (isFolderNotFound(err)) invalidateFolderRelated(queryClient);
      toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  return (
    <DialogShell
      title={submitLabel}
      description={lead}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </>
      }
    />
  );
}

export function GroupTransferDialog({
  note,
  pick,
  onClose,
  returnFocusRef,
}: {
  note: NoteDto;
  pick: GroupTransferPick;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const Body = pick.kind === "move" ? MoveDialog : CopyDialog;
  return <Body note={note} target={pick.target} onClose={onClose} returnFocusRef={returnFocusRef} />;
}
