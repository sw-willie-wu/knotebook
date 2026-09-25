import { useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useGroups } from "@/api/groups";
import { useNotes } from "@/api/notes";
import { useActiveNote } from "@/lib/active-note";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChevronRight, Plus } from "@/components/ui/icons";
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
}

function NoteRow({ note, primary }: NoteRowProps) {
  const { activeNoteId, setActiveNoteId } = useActiveNote();
  // #122：active 判準改吃 context 的 note.id（單一真相，理由見 lib/active-note.tsx
  // 檔頭）——不再比對路由參數（replaceState 換網址後 params 不動、slug 又隨標題
  // 重算，URL 判斷必失準；前身 matchesNoteRef 已退役）。
  const active = activeNoteId === note.id;
  return (
    <li
      className={cn(
        "flex h-11 items-center gap-1 rounded-md px-2 text-[13px] hover:bg-accent/60 md:h-7",
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

/** 每段一把折疊狀態：初值讀 localStorage 一次，之後 state 為準、寫入盡力而為。 */
function useCollapsed(key: SidebarSectionKey): [expanded: boolean, toggle: () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(key));
  const toggle = () => {
    const next = !collapsed;
    writeCollapsed(key, next);
    setCollapsed(next);
  };
  return [!collapsed, toggle];
}

/** 段標的「＋」（我的筆記／各群組段；工作坊段標的「＋」開的是新增群組對話框，見
 * `WorkspaceSection`）。24px ghost 圖示鈕，預設透明、列 hover／focus-within 或自身
 * focus-visible 才顯示——鍵盤 tab 到它時一定看得見（P19）。 */
function HeaderAddButton({
  label,
  onClick,
  disabled = false,
  buttonRef,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 工作坊「＋」用：讓新增群組對話框關閉時把焦點還回來（P17）。 */
  buttonRef?: RefObject<HTMLButtonElement | null>;
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
      // 24px（spec §8.1；P21）。觸控裝置沒有 hover，Tailwind v4 的 group-hover 只在
      // `@media (hover: hover)` 生效——`[@media(hover:none)]` 那條讓手機上常駐可見。
      className="h-6 w-6 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/section:opacity-100 group-focus-within/section:opacity-100 [@media(hover:none)]:opacity-100"
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
  /** 群組段：縮排一級＋左側細直線。 */
  nested?: boolean;
  /** 搜尋中一律展開（A5），折疊狀態保留不動。 */
  forceExpanded: boolean;
  children: ReactNode;
}

/**
 * 段標＝chevron＋名稱一顆 `<button aria-expanded>`，右側兄弟元素放「＋」／⋮。
 * `group/section` 讓「＋」在整列 hover／focus-within 時浮現。chevron 展開時轉 90°
 * （指下），收合時指右——等價於 spec 的「收合時 −90°」。
 */
function CollapsibleSection({ sectionKey, label, testId, actions, nested = false, forceExpanded, children }: CollapsibleSectionProps) {
  const [expanded, toggle] = useCollapsed(sectionKey);
  const open = forceExpanded || expanded;
  return (
    <div data-testid={testId} className={cn(nested && "ml-2 border-l border-border pl-1")}>
      <div className={cn("group/section flex items-center gap-0.5 pb-1", nested ? "pt-1" : "pt-3")}>
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

function NoteRows({ notes, primary }: { notes: NoteDto[]; primary: boolean }) {
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} primary={primary} />
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
 * spec §3.3 的分段表（`query` 為空時的主清單；搜尋只是在結果上再過濾）：
 * - `group` 非 null 且那個群組在 `groups`（＝我是成員）→ 該群組段（owner 或成員都一樣）；
 * - 否則 `role === "owner"` → 我的筆記（含 A1「我的、在 G、我已不是 G 成員」）；
 * - 否則 → 與我共享（含兜底列：`group` 非 null 但 G 不在 `groups`——剛被移出、清單未 refetch）。
 * 三桶互斥且完整，所以 `aria-current` 至多命中一列。「最近」＝原始清單前 2 篇（server 已按
 * `updated_at DESC`），可與主清單重複。
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
              label={t("sidebar.newNoteIn", { name: t("sidebar.myNotes") })}
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
        <CollapsibleSection sectionKey="workspace" testId="notegroup-workspace" label={t("sidebar.workspace")} forceExpanded={searching}>
          {groupsQuery.isPending && <p className="px-2 py-1 text-sm text-muted-foreground">{t("app.loading")}</p>}
          {groupsQuery.isError && (
            <p role="alert" className="px-2 py-1 text-sm text-destructive">
              {errorMessage(t, groupsQuery.error)}
            </p>
          )}
          {groupSections.map(
            ({ group, notes: groupNotes }) =>
              (!searching || groupNotes.length > 0) && (
                <CollapsibleSection
                  key={group.id}
                  sectionKey={`group:${group.id}`}
                  testId={`notegroup-group-${group.id}`}
                  label={group.name}
                  nested
                  forceExpanded={searching}
                  actions={
                    <HeaderAddButton
                      label={t("sidebar.newNoteIn", { name: group.name })}
                      onClick={() => onCreateNote?.(group.id)}
                      disabled={createNotePending}
                    />
                  }
                >
                  <NoteRows notes={groupNotes} primary />
                </CollapsibleSection>
              ),
          )}
        </CollapsibleSection>
      )}
    </>
  );
}
