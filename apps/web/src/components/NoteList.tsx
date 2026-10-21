import { useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useGroups } from "@/api/groups";
import { GroupMenu } from "@/components/groups/GroupMenu";
import { GroupNameDialog } from "@/components/groups/GroupNameDialog";
import { SidebarNoteMenu } from "@/components/NoteMenu";
import { useNotes } from "@/api/notes";
import { useActiveNote } from "@/lib/active-note";
import { useSidebarTabState } from "@/lib/sidebar-tab";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { hoverReveal } from "@/components/ui/reveal";
import { ChevronRight, Plus, Users } from "@/components/ui/icons";
import { EmptyState } from "@/components/EmptyState";
import { tabSpec, type HeaderActionId } from "@/components/sidebar/tab-specs";
import { buildTabNodes, noteLocationLabel, type SidebarNode } from "@/components/sidebar/tree";

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
function RoleBadge({ role, group }: { role: NoteDto["role"]; group: NoteDto["group"] }) {
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
  groupIds: ReadonlySet<string>;
}

/** 一列筆記：標題、徽章、⋮（`SidebarNoteMenu`，hover 浮出靠 `<li>` 的 `group/noterow`）。
 * 靜態卡與抽屜各一份 NoteList，所以一篇筆記的 ⋮ 最多兩份 DOM——測試一律 `within(...)` 鎖定面板。 */
function NoteRow({ note, variant, groupIds }: NoteRowProps) {
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
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{noteLocationLabel(note, groupIds, t)}</div>
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

/** 折疊狀態的 localStorage 鍵前綴（spec A6）：`sidebar.collapsed.group:<id>`，
 * 值 `"1"`＝收合、缺鍵＝展開（預設）。頂層四鍵隨 tab 化拿掉（舊值留在 storage 裡無害）。 */
export const COLLAPSE_STORAGE_PREFIX = "sidebar.collapsed.";

export type SidebarSectionKey = `group:${string}`;

function readCollapsed(key: SidebarSectionKey): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_PREFIX + key) === "1";
  } catch {
    // Safari 隱私模式／被封鎖的儲存：當作沒存過（預設展開），不讓側欄炸掉。
    return false;
  }
}

function writeCollapsed(key: SidebarSectionKey, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSE_STORAGE_PREFIX + key, "1");
    else window.localStorage.removeItem(COLLAPSE_STORAGE_PREFIX + key);
  } catch {
    // 寫不進去就只活在本次 session 的 state 裡。
  }
}

/** 每個群組一把折疊狀態：初值讀 localStorage 一次，之後 state 為準、寫入盡力而為。 */
function useCollapsed(key: SidebarSectionKey): [expanded: boolean, toggle: () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(key));
  const toggle = () => {
    const next = !collapsed;
    writeCollapsed(key, next);
    setCollapsed(next);
  };
  return [!collapsed, toggle];
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
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 工作坊標題列「＋」用：讓新增群組對話框關閉時把焦點還回來（P17）。 */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  reveal?: "grouprow";
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
      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
    </Button>
  );
}

interface NodeContext {
  tab: ReturnType<typeof useSidebarTabState>["tab"];
  groupIds: ReadonlySet<string>;
  onCreateNote?: (groupId?: string) => void;
  createNotePending: boolean;
}

/**
 * 工作坊 tab 的群組節點：像檔案樹的一個資料夾列。前導圖示槽平常是 `Users`，列 hover／
 * 列內有 `:focus-visible`（鍵盤焦點；滑鼠點完留下的焦點不算）時換成 chevron；觸控裝置（`hover: none`）一律 chevron。兩個圖示都
 * `aria-hidden`，button 的名稱只有群組名。筆記掛在導引線下，線對齊圖示槽中心
 * （px-2 8＋槽寬 14 / 2 ＝ 15px）。折疊共用 `useCollapsed`。
 */
function GroupNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "group" }>; ctx: NodeContext }) {
  const { t } = useTranslation();
  const { group } = node;
  const [open, toggle] = useCollapsed(`group:${group.id}`);
  return (
    <li data-node-kind="group" data-node-id={group.id} className="flex flex-col gap-0.5">
      <div className="group/grouprow flex h-7 items-center gap-0.5 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-foreground group-hover/grouprow:text-brand-on-soft"
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground group-hover/grouprow:text-brand-on-soft">
            <Users
              aria-hidden="true"
              className="h-3.5 w-3.5 group-hover/grouprow:hidden group-has-[:focus-visible]/grouprow:hidden [@media(hover:none)]:hidden"
            />
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "hidden h-3 w-3 transition-transform group-hover/grouprow:block group-has-[:focus-visible]/grouprow:block [@media(hover:none)]:block",
                open && "rotate-90",
              )}
            />
          </span>
          <span className="truncate">{group.name}</span>
        </button>
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

function SidebarNodeList({ nodes, ctx, inGroup = false }: { nodes: SidebarNode[]; ctx: NodeContext; inGroup?: boolean }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) =>
        node.kind === "group" ? (
          <GroupNode key={node.id} node={node} ctx={ctx} />
        ) : (
          <NoteRow
            key={node.id}
            note={node.note}
            variant={inGroup ? "group" : ctx.tab === "recent" ? "recent" : "plain"}
            groupIds={ctx.groupIds}
          />
        ),
      )}
    </ul>
  );
}

export interface NoteListProps {
  /** 標題列／群組列的「＋」：`groupId` 給群組列、不給＝個人筆記。state 與導向都在 `AppShell.handleNewNote`。 */
  onCreateNote?: (groupId?: string) => void;
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
 */
export function NoteList({ onCreateNote, createNotePending = false }: NoteListProps) {
  const { t } = useTranslation();
  const { tab } = useSidebarTabState();
  const notesQuery = useNotes();
  const groupsQuery = useGroups();
  const [createOpen, setCreateOpen] = useState(false);
  const addGroupRef = useRef<HTMLButtonElement>(null);

  const spec = tabSpec(tab);
  const groups = groupsQuery.data ?? [];
  const groupIds: ReadonlySet<string> = new Set(groups.map((group) => group.id));
  const ctx: NodeContext = { tab, groupIds, onCreateNote, createNotePending };
  const groupsAlert = groupsQuery.isError ? (
    <p role="alert" className="p-2 text-sm text-destructive">
      {errorMessage(t, groupsQuery.error)}
    </p>
  ) : null;

  function renderBody(): ReactNode {
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

    const nodes = buildTabNodes(tab, notes, groups);
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
      case "newGroup":
        return (
          <HeaderActionButton
            key={action}
            buttonRef={addGroupRef}
            label={t("sidebar.newGroup")}
            onClick={() => setCreateOpen(true)}
          />
        );
      default: {
        // 加新動作 id 時這裡編譯不過，不會默默渲染成別顆鈕。
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  return (
    <>
      <div data-sidebar-header="" className="flex items-center gap-0.5 px-2 pt-3 pb-1">
        <span className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
          <span className="truncate">{t(spec.labelKey)}</span>
        </span>
        {spec.actions.map(renderAction)}
      </div>
      {/* `key={tab}`：切 tab 換新元素，捲動位置回頂端（spec §5.3）。 */}
      <div key={tab} data-sidebar-list="" className="min-h-0 flex-1 overflow-y-auto px-2">
        {renderBody()}
      </div>
      {/* 對話框只在開啟時掛載，關閉時焦點還給標題列「＋」（`returnFocusRef`）。 */}
      {createOpen && <GroupNameDialog mode="create" open onOpenChange={setCreateOpen} returnFocusRef={addGroupRef} />}
    </>
  );
}
