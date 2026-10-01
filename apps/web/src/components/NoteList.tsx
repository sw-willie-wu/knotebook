import { useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useGroups } from "@/api/groups";
import { GroupMenu } from "@/components/groups/GroupMenu";
import { GroupNameDialog } from "@/components/groups/GroupNameDialog";
import { SidebarNoteMenu } from "@/components/NoteMenu";
import { useNotes } from "@/api/notes";
import { useActiveNote } from "@/lib/active-note";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { hoverReveal } from "@/components/ui/reveal";
import { ChevronRight, Plus, Users } from "@/components/ui/icons";
import { EmptyState } from "@/components/EmptyState";

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
 * 結果裡（server 只回傳使用者有權限看的筆記）。PR2：側欄改小字化，不再是 pill。 */
function RoleBadge({ role }: { role: NoteDto["role"] }) {
  const { t } = useTranslation();
  if (role !== "editor" && role !== "viewer") return null;
  return <span className="shrink-0 text-[11px] text-muted-foreground">{t(`roles.${role}`)}</span>;
}

interface NoteRowProps {
  note: NoteDto;
  /** 只有主清單（我的筆記／與我共享／各群組段）給 `aria-current`；「最近」是同一批筆記的
   * 複製顯示，active 只呈現視覺樣式，不重複宣告 `aria-current`（解 B3——否則
   * 一個頁面上會有兩個 `aria-current="page"`）。 */
  primary: boolean;
  /** `section`：左內距 24px，列文字對齊段名（段標 px-2 8＋chevron 12＋gap 4）；
   * `group`：群組導引線內，文字離線 12px。 */
  indent: RowIndent;
}

type RowIndent = "section" | "group";

/** 一列筆記：標題、徽章、⋮（`SidebarNoteMenu`，hover 浮出靠 `<li>` 的 `group/noterow`）。
 * ⋮ 在「最近」段也有（同一篇可能兩列各一顆）；靜態卡與抽屜各一份 NoteList，所以一篇筆記的
 * ⋮ 最多四份 DOM——測試一律 `within(...)` 鎖定段落容器。 */
function NoteRow({ note, primary, indent }: NoteRowProps) {
  const { activeNoteId, setActiveNoteId } = useActiveNote();
  // #122：active 判準改吃 context 的 note.id（單一真相，理由見 lib/active-note.tsx
  // 檔頭）——不再比對路由參數（replaceState 換網址後 params 不動、slug 又隨標題
  // 重算，URL 判斷必失準；前身 matchesNoteRef 已退役）。
  const active = activeNoteId === note.id;
  return (
    <li
      className={cn(
        "group/noterow flex h-11 items-center gap-1 rounded-md pr-2 text-[13px] hover:bg-accent/60 md:h-7",
        indent === "section" ? "pl-6" : "pl-3",
        // active 時 hover 必須跟主題色走：twMerge 對同一個 variant 群組（這裡是
        // `hover:bg-*`）互斥，後面這個 class 會蓋掉前面的 `hover:bg-accent/60`。
        // 非 active 的列維持中性 hover，不受這裡影響。
        active && "bg-brand-soft text-brand-on-soft font-medium hover:bg-brand-soft-strong",
      )}
    >
      {/* 刻意用 `<Link>` + 自算的 active，不用 `<NavLink>`：NavLink 比對的是
          location，而本 app 的網址會被 `history.replaceState` 換掉（location 不同步）。 */}
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
        aria-current={primary && active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center self-stretch truncate"
      >
        {note.title}
      </Link>
      <RoleBadge role={note.role} />
      <SidebarNoteMenu note={note} />
    </li>
  );
}

/** 折疊狀態的 localStorage 鍵前綴（spec A6）：`sidebar.collapsed.<recent|myNotes|shared|workspace|group:<id>>`，
 * 值 `"1"`＝收合、缺鍵＝展開（預設）。 */
export const COLLAPSE_STORAGE_PREFIX = "sidebar.collapsed.";

export type SidebarSectionKey = "recent" | "myNotes" | "shared" | "workspace" | `group:${string}`;

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

/** 每段一把折疊狀態：初值讀 localStorage 一次，之後 state 為準、寫入盡力而為。
 * `locked`（搜尋中強制展開）時 `toggle` 是 no-op——否則點段標會在看不見的地方翻動
 * 收合狀態（`aria-expanded` 恆 true），清掉搜尋後段落莫名收起。 */
function useCollapsed(key: SidebarSectionKey, locked: boolean): [expanded: boolean, toggle: () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(key));
  const toggle = () => {
    if (locked) return;
    const next = !collapsed;
    writeCollapsed(key, next);
    setCollapsed(next);
  };
  return [!collapsed, toggle];
}

/** 段標的「＋」（我的筆記／各群組段；工作坊段標的「＋」開的是新增群組對話框，見
 * `WorkspaceSection`）。24px ghost 圖示鈕，預設透明、列 hover／列內有 `:focus-visible`
 * 或自身 focus-visible 才顯示——鍵盤 tab 到它時一定看得見（P19）；滑鼠點過留下的
 * 焦點不算（不是 focus-within）。 */
function HeaderAddButton({
  label,
  onClick,
  disabled = false,
  buttonRef,
  scope = "section",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 工作坊「＋」用：讓新增群組對話框關閉時把焦點還回來（P17）。 */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** 跟哪一列的 hover／鍵盤焦點走：頂層段標（`group/section`）或群組列（`group/grouprow`）。 */
  scope?: "section" | "grouprow";
}) {
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      // 24px（spec §8.1；P21）。hover 浮出與觸控（`hover: none`）常駐見 `ui/reveal.ts`。
      className={cn("h-6 w-6 shrink-0", hoverReveal(scope))}
    >
      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
    </Button>
  );
}

interface CollapsibleSectionProps {
  sectionKey: SidebarSectionKey;
  label: string;
  /** 測試範圍化握把（既有三個名字不動；新增 `notegroup-workspace`、`notegroup-group-<id>`）。 */
  testId: string;
  /** 「＋」與 ⋮——放在段標 button 的**兄弟**位置（button 不可巢狀）。 */
  actions?: ReactNode;
  /** 搜尋中一律展開（A5），折疊狀態保留不動。 */
  forceExpanded: boolean;
  children: ReactNode;
}

/**
 * 頂層段標＝chevron＋名稱一顆 `<button aria-expanded>`，右側兄弟元素放「＋」。
 * `group/section` 讓「＋」在整列 hover／列內鍵盤焦點時浮現。chevron 展開時轉 90°
 * （指下），收合時指右——等價於 spec 的「收合時 −90°」。
 */
function CollapsibleSection({ sectionKey, label, testId, actions, forceExpanded, children }: CollapsibleSectionProps) {
  const [expanded, toggle] = useCollapsed(sectionKey, forceExpanded);
  const open = forceExpanded || expanded;
  return (
    <div data-testid={testId}>
      <div className="group/section flex items-center gap-0.5 pt-3 pb-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-left text-[11px] font-semibold tracking-wide text-muted-foreground hover:text-foreground"
        >
          <ChevronRight aria-hidden="true" className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="truncate">{label}</span>
        </button>
        {actions}
      </div>
      {open && children}
    </div>
  );
}

/**
 * 工作坊底下的群組：像檔案樹的一個資料夾列。前導圖示槽平常是 `Users`，列 hover／
 * 列內有 `:focus-visible`（鍵盤焦點；滑鼠點完留下的焦點不算）時換成 chevron；觸控裝置（`hover: none`）一律 chevron。兩個圖示都
 * `aria-hidden`，button 的名稱只有群組名。筆記掛在導引線下，線對齊圖示槽中心
 * （px-2 8＋槽寬 14 / 2 ＝ 15px）。折疊與搜尋鎖定共用 `useCollapsed`。
 */
function GroupSection({ sectionKey, label, testId, actions, forceExpanded, children }: CollapsibleSectionProps) {
  const [expanded, toggle] = useCollapsed(sectionKey, forceExpanded);
  const open = forceExpanded || expanded;
  return (
    <div data-testid={testId} className="flex flex-col gap-0.5">
      <div className="group/grouprow flex h-7 items-center gap-0.5 rounded-md hover:bg-accent/60">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-foreground"
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
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
          <span className="truncate">{label}</span>
        </button>
        {actions}
      </div>
      {open && <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">{children}</div>}
    </div>
  );
}

function NoteRows({ notes, primary, indent = "section" }: { notes: NoteDto[]; primary: boolean; indent?: RowIndent }) {
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} primary={primary} indent={indent} />
      ))}
    </ul>
  );
}

export interface SidebarPartition {
  recent: NoteDto[];
  myNotes: NoteDto[];
  shared: NoteDto[];
  /** 依 `groups` 的順序，每個群組一個桶（空桶也在，段標要渲染）。 */
  byGroup: Map<string, NoteDto[]>;
}

/**
 * #175 spec §8.2 的分段表（`query` 為空時的主清單；搜尋只是在結果上再過濾）：
 * - `group` 非 null 且那個群組在 `groups`（＝我是成員）→ 該群組段（徽章＝editor／viewer）；
 * - `group` 非 null 但群組不在 `groups`（剛被移出、清單未 refetch）→ 與我共享（兜底）；
 * - `role === "owner"` → 我的筆記；
 * - 其餘（逐人分享給我的個人筆記）→ 與我共享。
 * 群組筆記的 `role` 從不是 `owner`（群組持有、沒有個人 owner），所以第 2 列不必另寫分支——
 * 程式碼只要「在 `groups` 裡就進群組段，否則看 role」。四列互斥且完整，所以 `aria-current`
 * 至多命中一列。「最近」＝原始清單前 2 篇（server 已按 `updated_at DESC`），可與主清單重複。
 */
export function partitionNotes(notes: NoteDto[], groups: GroupDto[]): SidebarPartition {
  const byGroup = new Map<string, NoteDto[]>(groups.map((group) => [group.id, []]));
  const myNotes: NoteDto[] = [];
  const shared: NoteDto[] = [];
  for (const note of notes) {
    const bucket = note.group ? byGroup.get(note.group.id) : undefined;
    if (bucket) bucket.push(note);
    else if (note.role === "owner") myNotes.push(note);
    else shared.push(note);
  }
  return { recent: notes.slice(0, 2), myNotes, shared, byGroup };
}

export interface NoteListProps {
  /** 搜尋字串，state 放在 `AppShell`（Ctrl/Cmd+K 要跨元件聚焦搜尋框）。空＝無過濾。 */
  query?: string;
  /** 段標「＋」：`groupId` 給群組段、不給＝個人筆記。state 與導向都在 `AppShell.handleNewNote`。 */
  onCreateNote?: (groupId?: string) => void;
  createNotePending?: boolean;
}

/**
 * 側欄筆記清單（#103 起四段皆可折疊）：最近／我的筆記／與我共享／工作坊（每群組一段）。
 * `GET /api/notes` 四態顯式處理（loading／error／全空／搜尋無命中）；`GET /api/groups`
 * 的 pending／error **只影響工作坊段**（段標下顯示載入中或 `role="alert"`），不擋整個側欄，
 * 群組筆記在那期間依兜底列落段、資料到了再歸位。
 *
 * 空段規則（spec §8.1 表）：最近、與我共享為空 → 整段不渲染；我的筆記、工作坊、各群組段
 * 為空 → 段標仍渲染（D10–D12，空群組無引導文案）。`EmptyState` 只在筆記與群組**都**為空時
 * 取代整個清單。搜尋時（A5）：所有段強制展開、無命中的段不渲染、全無命中 → `sidebar.noMatch`。
 */
export function NoteList({ query, onCreateNote, createNotePending = false }: NoteListProps) {
  const { t } = useTranslation();
  const notesQuery = useNotes();
  const groupsQuery = useGroups();

  if (notesQuery.isPending) {
    return <p className="p-2 text-sm text-muted-foreground">{t("app.loading")}</p>;
  }

  if (notesQuery.isError) {
    return (
      <p role="alert" className="p-2 text-sm text-destructive">
        {errorMessage(t, notesQuery.error)}
      </p>
    );
  }

  const notes = notesQuery.data;
  const groups = groupsQuery.data ?? [];
  // 零筆記時要等群組清單才知道是 EmptyState 還是「有群組段標」——不然段標會閃一幀。
  if (notes.length === 0 && groupsQuery.isPending) {
    return <p className="p-2 text-sm text-muted-foreground">{t("app.loading")}</p>;
  }
  if (notes.length === 0 && groupsQuery.isSuccess && groups.length === 0) {
    return <EmptyState title={t("home.empty")} description={t("home.emptyDescription")} />;
  }

  const lowerQuery = (query ?? "").toLowerCase();
  const searching = lowerQuery.length > 0;
  const matchesQuery = (note: NoteDto) => note.title.toLowerCase().includes(lowerQuery);

  const parts = partitionNotes(notes, groups);
  const recent = parts.recent.filter(matchesQuery);
  const myNotes = parts.myNotes.filter(matchesQuery);
  const shared = parts.shared.filter(matchesQuery);
  const groupSections = groups.map((group) => ({ group, notes: (parts.byGroup.get(group.id) ?? []).filter(matchesQuery) }));
  const anyGroupHit = groupSections.some((section) => section.notes.length > 0);

  if (searching && recent.length === 0 && myNotes.length === 0 && shared.length === 0 && !anyGroupHit) {
    return <p className="p-2 text-sm text-muted-foreground">{t("sidebar.noMatch")}</p>;
  }

  return (
    <>
      {recent.length > 0 && (
        <CollapsibleSection sectionKey="recent" testId="notegroup-recent" label={t("sidebar.recent")} forceExpanded={searching}>
          <NoteRows notes={recent} primary={false} />
        </CollapsibleSection>
      )}

      {(!searching || myNotes.length > 0) && (
        <CollapsibleSection
          sectionKey="myNotes"
          testId="notegroup-myNotes"
          label={t("sidebar.myNotes")}
          forceExpanded={searching}
          actions={
            <HeaderAddButton
              label={t("sidebar.newPersonalNote")}
              onClick={() => onCreateNote?.(undefined)}
              disabled={createNotePending}
            />
          }
        >
          <NoteRows notes={myNotes} primary />
        </CollapsibleSection>
      )}

      {shared.length > 0 && (
        <CollapsibleSection sectionKey="shared" testId="notegroup-shared" label={t("sidebar.shared")} forceExpanded={searching}>
          <NoteRows notes={shared} primary />
        </CollapsibleSection>
      )}

      {(!searching || anyGroupHit) && (
        <WorkspaceSection
          searching={searching}
          groupsQuery={groupsQuery}
          groupSections={groupSections}
          onCreateNote={onCreateNote}
          createNotePending={createNotePending}
        />
      )}
    </>
  );
}

interface WorkspaceSectionProps {
  searching: boolean;
  groupsQuery: ReturnType<typeof useGroups>;
  groupSections: Array<{ group: GroupDto; notes: NoteDto[] }>;
  onCreateNote?: (groupId?: string) => void;
  createNotePending: boolean;
}

/**
 * 工作坊段（spec §8.1）：段標「＋」開新增群組對話框（§8.2），底下每個群組一段、段標右側
 * 「＋」（新筆記進該群組）與 ⋮（`GroupMenu`；與「＋」一起 hover 浮出）。對話框只在開啟時掛載，關閉時焦點還給
 * 「＋」（`returnFocusRef`）。側欄渲染兩份（靜態＋抽屜），各份的 state 互不相干。
 */
function WorkspaceSection({ searching, groupsQuery, groupSections, onCreateNote, createNotePending }: WorkspaceSectionProps) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <CollapsibleSection
        sectionKey="workspace"
        testId="notegroup-workspace"
        label={t("sidebar.workspace")}
        forceExpanded={searching}
        actions={<HeaderAddButton buttonRef={addButtonRef} label={t("sidebar.newGroup")} onClick={() => setCreateOpen(true)} />}
      >
        {groupsQuery.isPending && <p className="px-2 py-1 text-sm text-muted-foreground">{t("app.loading")}</p>}
        {groupsQuery.isError && (
          <p role="alert" className="px-2 py-1 text-sm text-destructive">
            {errorMessage(t, groupsQuery.error)}
          </p>
        )}
        <div className="flex flex-col gap-1 pl-4">
          {groupSections.map(
            ({ group, notes: groupNotes }) =>
              (!searching || groupNotes.length > 0) && (
                <GroupSection
                  key={group.id}
                  sectionKey={`group:${group.id}`}
                  testId={`notegroup-group-${group.id}`}
                  label={group.name}
                  forceExpanded={searching}
                  actions={
                    <>
                      {/* #175 §8.2：「＋」只在我的角色能在這個群組建立筆記時渲染（`myRole` null＝防禦，不渲染）。 */}
                      {group.myRole?.permissions.create && (
                        <HeaderAddButton
                          scope="grouprow"
                          label={t("sidebar.newNoteIn", { name: group.name })}
                          onClick={() => onCreateNote?.(group.id)}
                          disabled={createNotePending}
                        />
                      )}
                      <GroupMenu group={group} size="sidebar" />
                    </>
                  }
                >
                  <NoteRows notes={groupNotes} primary indent="group" />
                </GroupSection>
              ),
          )}
        </div>
      </CollapsibleSection>
      {createOpen && <GroupNameDialog mode="create" open onOpenChange={setCreateOpen} returnFocusRef={addButtonRef} />}
    </>
  );
}
