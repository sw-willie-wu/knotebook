import { lazy, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode, type RefObject, type SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath, type FolderDto, type FolderSpaceDto, type GroupDto, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { folderErrorMessage, useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { GroupMenu } from "@/components/groups/GroupMenu";
import { GroupNameDialog } from "@/components/groups/GroupNameDialog";
import { SidebarNoteMenu } from "@/components/NoteMenu";
import { useNotes } from "@/api/notes";
import { useActiveNote } from "@/lib/active-note";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { hoverReveal, type RevealScope } from "@/components/ui/reveal";
import { FolderPlus, Plus, SquareCheck } from "@/components/ui/icons";
import { EmptyState } from "@/components/EmptyState";
import { useCollapsed } from "@/components/sidebar/collapse";
import { indexFolders, liveNotesUnder } from "@/components/sidebar/folder-index";
import { FolderMenu } from "@/components/sidebar/FolderMenu";
import { useFolderSortOf } from "@/components/sidebar/folder-sort";
import { FolderRowButton } from "@/components/sidebar/FolderRowButton";
import { GroupRowButton } from "@/components/sidebar/GroupRowButton";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import type { StackPreviewState } from "@/components/sidebar/drag-session";
import { StackPreview } from "@/components/sidebar/StackPreview";
import { tabSpec, type HeaderActionId } from "@/components/sidebar/tab-specs";
import { DROP_SCOPE_CLASS, useSidebarDrag } from "@/components/sidebar/useSidebarDrag";
import { buildTabNodes, hasSelectableNodes, noteLocationLabel, noteSpaceKey, type LocationContext, type SidebarNode } from "@/components/sidebar/tree";

// 一般 tab 選取模式（PR-2c）：只准經 SelectLazy 這個 lazy 入口（首包上限）。兩個掛點共用同一個 chunk。
const SelectHeader = lazy(() => import("@/components/sidebar/SelectLazy").then((m) => ({ default: m.SelectHeader })));
const SelectableTree = lazy(() => import("@/components/sidebar/SelectLazy").then((m) => ({ default: m.SelectableTree })));
// 資料夾對話框（新增／改名／刪除）：只准經 FolderLazy 這個 lazy 入口（首包上限）。
const FolderDialogs = lazy(() => import("@/components/sidebar/FolderLazy").then((m) => ({ default: m.FolderDialogs })));

/**
 * 疊資料夾建好後的改名框（資料夾 spec §6.6、§6.13 第 6 步）：`onClosed` 在關閉時以最後的名字呼叫恰一次（送出＝送出的名字、取消＝原名）；
 * `focusTarget` 在關閉當下才解析（新資料夾列是重抓後才出現的）。
 */
export interface StackRenameHooks {
  onClosed: (finalName: string) => void;
  focusTarget: () => HTMLElement | null;
}

/** 資料夾對話框的請求（host 在每份 NoteList 實例各一份；T4 的資料夾 ⋮ 也經 `NodeContext.openFolderDialog` 開框）。 */
export type FolderDialogRequest =
  | { kind: "create"; parent: { folderId: string } | { space: FolderSpaceDto } }
  | { kind: "rename"; folder: FolderDto; stack?: StackRenameHooks }
  | { kind: "delete"; folder: FolderDto };

const EMPTY_GROUPS: GroupDto[] = [];
const EMPTY_FOLDERS: FolderDto[] = [];
const EMPTY_NOTES: NoteDto[] = [];
const EMPTY_NODES: SidebarNode[] = [];

/** ApiFail → errors.<code>；其餘（網路失敗等）→ errors.fallback。與 LoginPage
 * 逐字同一套對映規則（見 client.ts 的說明）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/** 分享角色徽章——只給非 owner（editor/viewer）的筆記顯示；owner 自己的筆記不需要
 * 徽章（列表本身已隱含「這是你的」），'none' 理論上不會出現在 GET /api/notes 的
 * 結果裡（server 只回傳使用者有權限看的筆記）。PR2：側欄改小字化，不再是 pill。
 * #182（Willie 2026-10-02）：群組筆記（`group` 非 null）一律不標——角色看筆記頁頂端徽章；
 * 只有逐人分享給我的個人筆記保留。 */
export function RoleBadge({ role, group }: { role: NoteDto["role"]; group: NoteDto["group"] }) {
  const { t } = useTranslation();
  if (group) return null;
  if (role !== "editor" && role !== "viewer") return null;
  return <span className="shrink-0 text-[11px] text-muted-foreground">{t(`roles.${role}`)}</span>;
}

/** `plain`：頂層清單（我的筆記／與我共享），`pl-2`；`group`：群組導引線內，文字離線 12px；
 * `recent`：最近 tab 的兩行列（標題＋位置），角色在位置行、不放 `RoleBadge`。 */
type RowVariant = "plain" | "group" | "recent";

interface NoteRowProps {
  note: NoteDto;
  variant: RowVariant;
  location: LocationContext;
}

/** 一列筆記：標題、徽章、⋮（`SidebarNoteMenu`，hover 浮出靠 `<li>` 的 `group/noterow`）。
 * 靜態卡與抽屜各一份 NoteList，所以一篇筆記的 ⋮ 最多兩份 DOM——測試一律 `within(...)` 鎖定面板。 */
function NoteRow({ note, variant, location }: NoteRowProps) {
  const { t } = useTranslation();
  const { activeNoteId, setActiveNoteId } = useActiveNote();
  // #122：active 判準改吃 context 的 note.id（單一真相，理由見 lib/active-note.tsx
  // 檔頭）——不再比對路由參數（slug 隨標題重算、網址在存檔回來後才換，URL 判斷會
  // 有落差；前身 matchesNoteRef 已退役）。
  const active = activeNoteId === note.id;
  return (
    <li
      data-node-kind="note"
      data-node-id={note.id}
      className={cn(
        "group/noterow flex items-center gap-1 rounded-md pr-2 text-[13px] hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
        variant === "recent" ? "pl-2" : "h-11 md:h-7",
        variant === "plain" && "pl-2",
        variant === "group" && "pl-3",
        // #247 §4.10（Willie W18）：非 active 的列走主題色四態（與管理面板左卡項次同）：平常無底、hover
        // `bg-brand-soft`、按下 `active:bg-brand-soft-strong`、selected `bg-brand-soft`。
        // active 時 hover 要再深一階：twMerge 對同一個 variant 群組（`hover:bg-*`）互斥，後面這個 class
        // 會蓋掉前面的 `hover:bg-brand-soft`——所以這裡必須走 `cn(...)`，不能字串串接。
        active && "bg-brand-soft text-brand-on-soft font-medium hover:bg-brand-soft-strong",
      )}
    >
      {/* 刻意用 `<Link>` + 自算的 active，不用 `<NavLink>`：NavLink 比對的是
          location，舊形 `/notes/:ref`、prev_slug 等非 canonical 網址都對不上（#179 起收斂走
          router navigate，location 與網址列一致，但 id 仍是唯一不會變的判準）。 */}
      <Link
        to={canonicalNotePath(note)}
        onClick={(event) => {
          // 樂觀 set 僅限 plain left-click（spec m5-7 逐字：擋 meta/ctrl/shift）：
          // 那些組合是「開新分頁/視窗」——本頁不導航，樂觀 set 會把高亮留在沒開的
          // 那篇。中鍵不觸發 onClick（auxclick），天然排除。alt＋左鍵（部分瀏覽器
          // 是下載、同樣不導航）**已知未涵蓋**——spec 未列，暫不偏離。
          if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
            setActiveNoteId(note.id);
          }
        }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 self-stretch",
          variant === "recent" ? "flex-col justify-center py-1.5" : "items-center truncate",
        )}
      >
        {variant === "recent" ? (
          // 兩行一律 <div>：可及名稱靠 UA 預設 block 之間補空白（jsdom 不載 Tailwind，span 會黏成「標題位置」）。
          <>
            <div className="truncate text-[13px]">{note.title}</div>
            <LocationLine label={noteLocationLabel(note, location, t)} />
          </>
        ) : (
          note.title
        )}
      </Link>
      {variant !== "recent" && <RoleBadge role={note.role} group={note.group} />}
      <SidebarNoteMenu note={note} />
    </li>
  );
}

/** 最近 tab 的第二行：太長時 CSS truncate，`title` 給完整路徑（資料夾 spec §6.9）。 */
function LocationLine({ label }: { label: string }) {
  return (
    <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={label}>
      {label}
    </div>
  );
}

/** 標題列／群組列右側的 24px「＋」圖示鈕。tab 標題列的常駐；群組列的帶 `reveal="grouprow"`
 * （列 hover 或列內有 `:focus-visible` 才顯示——鍵盤 tab 到它時一定看得見（P19）；滑鼠點過留下的
 * 焦點不算（不是 focus-within））。 */
function HeaderActionButton({
  label,
  onClick,
  disabled = false,
  buttonRef,
  reveal,
  icon: Icon = Plus,
}: {
  label: string;
  /** `currentTarget` 給開框的呼叫端當還焦點的對象。 */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** 工作坊標題列「＋」用：讓新增群組對話框關閉時把焦點還回來（P17）。 */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  reveal?: RevealScope;
  /** 預設「＋」；「新增資料夾」傳 `FolderPlus`。 */
  icon?: (props: SVGProps<SVGSVGElement>) => ReactElement;
}) {
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      // 24px（spec §8.1；P21）。hover 浮出與觸控（`hover: none`）常駐見 `ui/reveal.ts`。
      className={cn("h-6 w-6 shrink-0", reveal && hoverReveal(reveal))}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
    </Button>
  );
}

interface NodeContext {
  tab: ReturnType<typeof useSidebarTabState>["tab"];
  location: LocationContext;
  onCreateNote?: (groupId?: string, folderId?: string) => void;
  createNotePending: boolean;
  /** 開資料夾對話框；`opener` 是關框時還焦點的對象。 */
  openFolderDialog: (request: FolderDialogRequest, opener: HTMLElement | null) => void;
  /** 快取裡的筆記：資料夾 ⋮ 開啟時判斷子樹有沒有活筆記（刪除擋下）。 */
  notes: readonly NoteDto[];
  /** 拖曳的落點範圍提示鍵（`dropScopeKey`："list"｜"group:<id>"｜"folder:<id>"）；null＝不標示。 */
  dropScope: string | null;
  /** 疊資料夾預覽或「建立中」：取代 `anchorNoteId` 那一列（`creating` 優先）。 */
  stack: { state: StackPreviewState; creating: boolean } | null;
}

/**
 * 工作坊 tab 的群組節點：像檔案樹的一個資料夾列（折疊主鈕見 `GroupRowButton`）。筆記掛在導引線下，線對齊圖示槽中心
 * （px-2 8＋槽寬 14 / 2 ＝ 15px）。折疊狀態是 `sidebar/collapse.ts` 的共用 store（靜態卡、抽屜、選取樹同步）。
 */
function GroupNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "group" }>; ctx: NodeContext }) {
  const { t } = useTranslation();
  const { group } = node;
  const [open, toggle] = useCollapsed(`group:${group.id}`);
  const dropScoped = ctx.dropScope === `group:${group.id}`;
  return (
    <li
      data-node-kind="group"
      data-node-id={group.id}
      data-drop-scope={dropScoped ? "" : undefined}
      className={cn("flex flex-col gap-0.5", dropScoped && DROP_SCOPE_CLASS)}
    >
      <div className="group/grouprow flex h-7 items-center gap-0.5 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong">
        <GroupRowButton name={group.name} open={open} onToggle={toggle} />
        {/* 資料夾 spec §6.3、N7：能編輯群組筆記才能建資料夾；排在「＋」之前（稿 `Workshop`，讀碼發現 19）。 */}
        {group.myRole?.permissions.edit && (
          <HeaderActionButton
            reveal="grouprow"
            icon={FolderPlus}
            label={t("sidebar.newFolderIn", { group: group.name })}
            onClick={(event) => ctx.openFolderDialog({ kind: "create", parent: { space: { kind: "group", groupId: group.id } } }, event.currentTarget)}
          />
        )}
        {/* #175 §8.2＋PR3：「＋」只在我的角色能在這個群組建立**且能編輯**筆記時渲染——能建不能改的人建出來的是
            自己也改不了的空白筆記（spec 疑點 11；他仍可經移入／複製把筆記放進群組，PR2）；`myRole` null＝防禦，不渲染。 */}
        {group.myRole?.permissions.create && group.myRole.permissions.edit && (
          <HeaderActionButton
            reveal="grouprow"
            label={t("sidebar.newNoteIn", { name: group.name })}
            onClick={() => ctx.onCreateNote?.(group.id)}
            disabled={ctx.createNotePending}
          />
        )}
        <GroupMenu group={group} size="sidebar" />
      </div>
      {open && (
        <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">
          <SidebarNodeList nodes={node.children} ctx={ctx} inGroup />
        </div>
      )}
    </li>
  );
}

/** 群組資料夾的 groupId（建立筆記時要同時帶，讀碼發現 1-①）；個人／共享資料夾 → undefined。 */
function groupIdOf(folder: FolderDto): string | undefined {
  return folder.space.kind === "group" ? folder.space.groupId : undefined;
}

/**
 * 資料夾節點（資料夾 spec §6.3）：折疊主鈕見 `FolderRowButton`，子節點掛導引線（同 `GroupNode`）。折疊鍵 `folder:<id>`
 * 是 `sidebar/collapse.ts` 的共用 store。「沒有筆記」只在沒有任何子節點時出現（只有子資料夾時不說）。⋮ 在 T4。
 */
function FolderNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "folder" }>; ctx: NodeContext }) {
  const { t } = useTranslation();
  const { folder } = node;
  const [open, toggle] = useCollapsed(`folder:${folder.id}`);
  const dropScoped = ctx.dropScope === `folder:${folder.id}`;
  return (
    <li
      data-node-kind="folder"
      data-node-id={folder.id}
      data-drop-scope={dropScoped ? "" : undefined}
      className={cn("flex flex-col gap-0.5", dropScoped && DROP_SCOPE_CLASS)}
    >
      <div className="group/folderrow flex h-11 items-center gap-0.5 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong md:h-7">
        <FolderRowButton name={folder.name} open={open} onToggle={toggle} />
        {folder.permissions.createNote && (
          <HeaderActionButton
            reveal="folderrow"
            label={t("sidebar.newNoteIn", { name: folder.name })}
            onClick={() => ctx.onCreateNote?.(groupIdOf(folder), folder.id)}
            disabled={ctx.createNotePending}
          />
        )}
        <FolderMenu
          folder={folder}
          depth={node.depth}
          hasLiveNotes={() => liveNotesUnder(ctx.location.folders, folder.id, ctx.notes, (note) => noteSpaceKey(note, ctx.location.groupIds)).length > 0}
          onCreateNote={() => ctx.onCreateNote?.(groupIdOf(folder), folder.id)}
          createNotePending={ctx.createNotePending}
          onRequest={ctx.openFolderDialog}
        />
      </div>
      {open && (
        <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">
          {node.children.length === 0 ? (
            <p className="flex h-11 items-center pl-3 text-[11px] text-muted-foreground md:h-7">{t("sidebar.folderEmpty")}</p>
          ) : (
            <SidebarNodeList nodes={node.children} ctx={ctx} inGroup />
          )}
        </div>
      )}
    </li>
  );
}

function SidebarNodeList({ nodes, ctx, inGroup = false }: { nodes: SidebarNode[]; ctx: NodeContext; inGroup?: boolean }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) =>
        node.kind === "group" ? (
          <GroupNode key={node.id} node={node} ctx={ctx} />
        ) : node.kind === "folder" ? (
          <FolderNode key={node.id} node={node} ctx={ctx} />
        ) : ctx.stack !== null && ctx.stack.state.anchorNoteId === node.id ? (
          <StackPreview
            key={node.id}
            name={ctx.stack.state.name}
            anchorTitle={node.note.title}
            sourceTitle={ctx.stack.state.sourceTitle}
            creating={ctx.stack.creating}
            variant={inGroup ? "group" : "plain"}
          />
        ) : (
          <NoteRow
            key={node.id}
            note={node.note}
            variant={inGroup ? "group" : ctx.tab === "recent" ? "recent" : "plain"}
            location={ctx.location}
          />
        ),
      )}
    </ul>
  );
}

export interface NoteListProps {
  /** 標題列／群組列／資料夾列的「＋」：`groupId` 給群組（含群組資料夾）、`folderId` 給資料夾、都不給＝個人根層。state 與導向都在 `AppShell.handleNewNote`。 */
  onCreateNote?: (groupId?: string, folderId?: string) => void;
  createNotePending?: boolean;
}

const MESSAGE_CLASS = "p-2 text-sm text-muted-foreground";

/**
 * 側欄「目前 tab 的面板」：標題列（名稱＋該 tab 宣告的動作）＋清單（遞迴節點樹）。tabpanel 外框由
 * `AppShell` 提供（本元件假設自己在它裡面，是 flex-col 的子層）。
 * `GET /api/notes` 的 pending／error 在清單內顯示；`GET /api/groups` 的 pending／error 只影響
 * 工作坊 tab（與「零筆記時要等群組才知道是不是全空」），群組筆記在那期間依兜底列落與我共享、
 * 資料到了再歸位。搜尋由 `sidebar/SearchResults` 負責。
 * tabpanel 的 `tabIndex={0}` 在 `AppShell`（WAI-ARIA APG：面板第一個有內容的元素不可聚焦時，Tab 要能停在面板上）。
 *
 * 選取模式（PR-2c，spec §6.11）：標題列「選取」由這裡渲染；進入後標題列內容換成 lazy 的 `SelectHeader`、清單內容換成
 * `SelectableTree`（`SelectLazy` chunk，fallback 是平常的名稱與列）。捲動容器 `[data-sidebar-list]` 不換（捲動位置不跳）。
 * `nodes`／`groupIds` 以 `useMemo` 穩定，選取列的 memo 才有效。焦點只由發起的那一份實例移動（`focusAfterRef`：進入→「完成」、
 * 離開→「選取」）。Esc 由 `SelectHeader` 在 document 層處理（本元件不掛）。群組折疊與選取樹共用 `sidebar/collapse.ts`。
 */
export function NoteList({ onCreateNote, createNotePending = false }: NoteListProps) {
  const { t } = useTranslation();
  const { tab, selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  const notesQuery = useNotes();
  const groupsQuery = useGroups();
  const foldersQuery = useFolders();
  const sortOf = useFolderSortOf();
  const [createOpen, setCreateOpen] = useState(false);
  const addGroupRef = useRef<HTMLButtonElement>(null);
  const [folderRequest, setFolderRequest] = useState<FolderDialogRequest | null>(null);
  const folderOpenerRef = useRef<HTMLElement | null>(null);
  const selectButtonRef = useRef<HTMLButtonElement>(null);
  /** 進出選取模式後要聚焦的鈕：只有發起的這一份實例會設（靜態卡與抽屜同時在 DOM，另一份不搶焦點）。 */
  const focusAfterRef = useRef<"done" | "select" | null>(null);

  const spec = tabSpec(tab);
  const groups = groupsQuery.data ?? EMPTY_GROUPS;
  // memo（plan gate r1 I2）：不 memo 的話每次勾選都換 `nodes`／`groupIds`，選取樹的 `onToggle` 隨之換、所有列重繪。
  const groupIds = useMemo<ReadonlySet<string>>(() => new Set((groupsQuery.data ?? EMPTY_GROUPS).map((group) => group.id)), [groupsQuery.data]);
  // 讀碼發現 3：我的筆記／工作坊／與我共享等 `["folders"]`（不先平鋪再跳）；失敗且沒有舊資料 → 空索引（筆記落根層）＋錯誤列。最近 tab 不等。
  const waitFolders = tab !== "recent" && tab !== "trash";
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? EMPTY_FOLDERS), [foldersQuery.data]);
  const location = useMemo<LocationContext>(() => ({ groupIds, folders: folderIndex }), [groupIds, folderIndex]);
  const foldersPending = waitFolders && foldersQuery.isPending;
  const nodes = useMemo(
    () =>
      notesQuery.isSuccess && (tab !== "workspace" || groupsQuery.data !== undefined) && !foldersPending
        ? buildTabNodes(tab, notesQuery.data, groupsQuery.data ?? EMPTY_GROUPS, folderIndex, sortOf)
        : null,
    [tab, notesQuery.isSuccess, notesQuery.data, groupsQuery.data, foldersPending, folderIndex, sortOf],
  );
  const selectable = nodes !== null && hasSelectableNodes(nodes);
  const openFolderDialog = (request: FolderDialogRequest, opener: HTMLElement | null) => {
    folderOpenerRef.current = opener;
    setFolderRequest(request);
  };
  // 拖曳（資料夾 spec §6.13）：容器事件委派；兩份實例共用 drag-session 的狀態，只有發起的那一份驅動。
  const drag = useSidebarDrag({ tab, nodes, groupIds, folderIndex, openFolderDialog });
  const listDropScoped = drag.view.scope === "list";
  const stackState = drag.view.creating ?? drag.view.preview;
  const ctx: NodeContext = {
    tab,
    location,
    onCreateNote,
    createNotePending,
    openFolderDialog,
    notes: notesQuery.data ?? EMPTY_NOTES,
    dropScope: drag.view.scope,
    stack: stackState === null ? null : { state: stackState, creating: drag.view.creating !== null },
  };

  useEffect(() => {
    if (selection.active) return;
    // 選取結束：發起的那一份把焦點交回「選取」；沒掛上 SelectHeader 就結束的「done」旗標一併清掉。
    const target = focusAfterRef.current;
    focusAfterRef.current = null;
    if (target === "select") selectButtonRef.current?.focus();
  }, [selection.active]);
  const groupsAlert = groupsQuery.isError ? (
    <p role="alert" className="p-2 text-sm text-destructive">
      {errorMessage(t, groupsQuery.error)}
    </p>
  ) : null;
  const foldersAlert =
    waitFolders && foldersQuery.isError && foldersQuery.data === undefined ? (
      <p role="alert" className="p-2 text-sm text-destructive">
        {folderErrorMessage(t, foldersQuery.error)}
      </p>
    ) : null;

  function renderBody(): ReactNode {
    const body = renderList();
    // 筆記清單本身載入失敗時只顯示那一則錯誤，不疊資料夾的。
    if (foldersAlert === null || body === null || !notesQuery.isSuccess) return body;
    return (
      <>
        {foldersAlert}
        {body}
      </>
    );
  }

  function renderList(): ReactNode {
    if (notesQuery.isPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
    if (notesQuery.isError) {
      return (
        <p role="alert" className="p-2 text-sm text-destructive">
          {errorMessage(t, notesQuery.error)}
        </p>
      );
    }
    const notes = notesQuery.data;
    const emptyState = <EmptyState title={t("home.empty")} description={t("home.emptyDescription")} />;

    if (tab === "workspace") {
      if (groupsQuery.isPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
      // 背景 refetch 失敗時 data 仍是上一次成功的群組：錯誤句與快取清單並列，不把群組藏掉。
      if (groupsQuery.isError && groupsQuery.data === undefined) return groupsAlert;
      // 零群組：只放說明文字、不放「新增群組」鈕——新增一律走標題列「＋」（總管裁定 2026-10-21，避免兩顆同名鈕）。
      if (groups.length === 0) {
        return (
          <>
            {groupsAlert}
            <p className={MESSAGE_CLASS}>{t("sidebar.emptyWorkspace")}</p>
          </>
        );
      }
    }

    if (foldersPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
    // 上面已處理 pending／error（工作坊另含群組、資料夾），到這裡 `nodes` 一定有值。
    if (nodes === null) return null;
    if (nodes.length === 0) {
      if (tab === "recent") return emptyState;
      if (tab === "shared") return <p className={MESSAGE_CLASS}>{t("sidebar.emptyShared")}</p>;
      if (tab === "myNotes") {
        // 零筆記時要等群組清單才知道是 EmptyState 還是「有群組、只是沒個人筆記」——不然會閃一幀。
        if (notes.length === 0 && groupsQuery.isPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
        if (notes.length === 0 && groupsQuery.isSuccess && groups.length === 0) return emptyState;
        return <p className={MESSAGE_CLASS}>{t("sidebar.emptyMyNotes")}</p>;
      }
    }
    return (
      <>
        {tab === "workspace" && groupsAlert}
        <SidebarNodeList nodes={nodes} ctx={ctx} />
      </>
    );
  }

  function renderAction(action: HeaderActionId): ReactNode {
    switch (action) {
      case "newPersonalNote":
        return (
          <HeaderActionButton
            key={action}
            label={t("sidebar.newPersonalNote")}
            onClick={() => onCreateNote?.(undefined)}
            disabled={createNotePending}
          />
        );
      case "newFolder":
        // 我的筆記與與我共享宣告這個動作（資料夾 spec §6.1）：建在該 tab 的空間根層。
        return (
          <HeaderActionButton
            key={action}
            icon={FolderPlus}
            label={t("sidebar.newFolder")}
            onClick={(event) =>
              openFolderDialog({ kind: "create", parent: { space: { kind: tab === "shared" ? "shared" : "personal" } } }, event.currentTarget)
            }
          />
        );
      case "newGroup":
        return (
          <HeaderActionButton
            key={action}
            buttonRef={addGroupRef}
            label={t("sidebar.newGroup")}
            onClick={() => setCreateOpen(true)}
          />
        );
      case "selectMode":
        // 同 `TrashPanel` 那顆（24px 例外，button.tsx 檔頭）；字沿用首包的 `trash.select`（一般 tab 也叫「選取」，改鍵名要動首包兩語系）。
        return (
          <Button
            key={action}
            ref={selectButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("trash.select")}
            title={t("trash.select")}
            disabled={!selectable}
            // 握把：離開選取模式後經 `[data-sidebar-instance]` 找回同一份的這顆鈕聚焦（`SIDEBAR_SELECT_BUTTON`）。
            data-sidebar-select=""
            // 已在選取模式時不重送 `start`（reducer 的 start 會清空已勾的）。
            onClick={() => {
              if (selection.active) return;
              focusAfterRef.current = "done";
              updateSelection({ type: "start" });
            }}
            className="h-6 w-6 shrink-0"
          >
            <SquareCheck aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        );
      // 只在垃圾桶 tab 宣告，由 `TrashPanel` 自己渲染。
      case "emptyTrash":
        return null;
      default: {
        // 加新動作 id 時這裡編譯不過，不會默默渲染成別顆鈕。
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  const tabLabel = (
    <span className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
      <span className="truncate">{t(spec.labelKey)}</span>
    </span>
  );

  return (
    <>
      <div data-sidebar-header="" className="flex items-center gap-0.5 px-2 pt-3 pb-1">
        {selection.active ? (
          // chunk 還沒到：只有名稱（不含動作鈕）。
          <SidebarLazyBoundary chunk="select" fallback={tabLabel} errorClassName="hidden">
            <SelectHeader
              nodes={nodes ?? EMPTY_NODES}
              onMounted={(done) => {
                if (focusAfterRef.current !== "done") return;
                focusAfterRef.current = null;
                done?.focus();
              }}
              onDone={() => {
                focusAfterRef.current = "select";
                updateSelection({ type: "end" });
              }}
            />
          </SidebarLazyBoundary>
        ) : (
          <>
            {tabLabel}
            {spec.actions.map(renderAction)}
          </>
        )}
      </div>
      {/* `key={tab}`：切 tab 換新元素，捲動位置回頂端（spec §5.3）。進出選取模式不換（捲動位置不跳）。 */}
      {/* 安全網（讀碼發現 10）：橫向裁切放在內層包層——放在清單本身會因另一軸是 `overflow-y-auto` 算成 `hidden`，仍可被捲動橫移。 */}
      {/* 拖曳的 dragstart／dragover／drop／dragend 都委派在這個容器（spec §6.13）；包層 `min-h-full`：清單下方空白也算根目錄的標示範圍。 */}
      <div key={tab} data-sidebar-list="" className="min-h-0 flex-1 overflow-y-auto" {...drag.containerProps}>
        <div
          data-drop-scope={listDropScoped ? "" : undefined}
          className={cn("min-h-full overflow-x-clip px-2", listDropScoped && DROP_SCOPE_CLASS)}
        >
          {selection.active && nodes !== null && nodes.length > 0 && tab !== "trash" ? (
            // chunk 還沒到：照常顯示平常的列，到了才換勾選框。選取中清單重抓後變得沒有可勾的篇（只剩空群組）也留在勾選樹：
            // 群組列不帶「＋」與 ⋮，與選取標題列一致；完全沒有節點時是平常的空狀態句（沒有動作鈕）。
            <SidebarLazyBoundary chunk="select" fallback={<SidebarNodeList nodes={nodes} ctx={ctx} />} errorClassName="p-2">
              <SelectableTree nodes={nodes} tab={tab} location={location} />
            </SidebarLazyBoundary>
          ) : (
            renderBody()
          )}
        </div>
      </div>
      {/* 對話框只在開啟時掛載，關閉時焦點還給標題列「＋」（`returnFocusRef`）。 */}
      {createOpen && <GroupNameDialog mode="create" open onOpenChange={setCreateOpen} returnFocusRef={addGroupRef} />}
      {/* 資料夾對話框：只在開啟時掛載；chunk 載入失敗時顯示 inline 錯誤（不藏起來，否則是一排沒反應的鈕）。 */}
      {folderRequest && (
        <SidebarLazyBoundary chunk="folder" fallback={null} errorClassName="p-2">
          <FolderDialogs request={folderRequest} returnFocusRef={folderOpenerRef} onClose={() => setFolderRequest(null)} />
        </SidebarLazyBoundary>
      )}
    </>
  );
}
