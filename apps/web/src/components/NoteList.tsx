import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useNotes } from "@/api/notes";
import { useActiveNote } from "@/lib/active-note";
import { cn } from "@/lib/utils";
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
  /** 只有主清單（我的筆記／與我共享）給 `aria-current`；「最近」是同一批筆記的
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

interface NoteGroupProps {
  testId: string;
  label: string;
  notes: NoteDto[];
  primary: boolean;
}

function NoteGroup({ testId, label, notes, primary }: NoteGroupProps) {
  if (notes.length === 0) return null;
  return (
    // `data-testid`：測試範圍化握把，勿移除——「最近」跟主清單刻意重複顯示同一篇
    // 筆記（見本檔檔頭），單數 `getByRole` 查詢在重複下會因命中多個節點而 throw，
    // 測試靠這個 testid 用 `within()` 鎖定要斷言的那個分組。
    <div data-testid={testId}>
      <p className="px-2 pb-1 pt-3 text-[11px] font-semibold tracking-wide text-muted-foreground">{label}</p>
      <ul className="space-y-0.5">
        {notes.map((note) => (
          <NoteRow key={note.id} note={note} primary={primary} />
        ))}
      </ul>
    </div>
  );
}

interface NoteListProps {
  /** 搜尋字串，state 放在 `AppShell`（Ctrl/Cmd+K 要跨元件聚焦搜尋框）。選填——
   * 不傳或空字串都視為「無過濾」（`"".includes()` 對任何字串恆真，過濾函式
   * 不需要為空字串特殊處理）。 */
  query?: string;
}

/**
 * 側欄筆記清單——`GET /api/notes`（Task 10 的 `useNotes`）四態顯式處理：
 * - loading（`isPending`）：`app.loading` 文案，跟 `guards.tsx` 的 `FullScreenLoading`
 *   共用同一把 key。
 * - error（`isError`）：`role="alert"`，ApiFail → `errors.<code>`，否則 `errors.fallback`。
 * - 全空（成功但 `data.length === 0`）：`EmptyState` 引導建立第一篇筆記。
 * - 有筆記但搜尋過濾後三組都是空的：`sidebar.noMatch` 文案（跟「全空」是不同語意，
 *   不共用 `home.empty*` 那組 key）。
 *
 * PR2 側欄改三分組（**先分組、後過濾**）：
 * 1. `sidebar.recent`——server 已按 `updated_at DESC` 回傳，固定取原始（未過濾）
 *    清單的前 2 篇，再對這個固定集合套用搜尋過濾（過濾後可能剩 0～2 篇）。
 * 2. `sidebar.myNotes`——`role === "owner"` 的筆記。
 * 3. `sidebar.shared`——`role === "editor" | "viewer"` 的筆記。
 *
 * 「最近」跟另外兩組刻意**會重複顯示同一篇筆記**（最近的某篇同時也是我的筆記或
 * 與我共享）——這是設計定案，不是 bug；`aria-current` 因此只給主清單（見
 * `NoteRow` 的說明），避免一個頁面上出現兩個 `aria-current="page"`。
 *
 * 每列連到 `canonicalNotePath(note)`＝`/n/<ownerHandle>/<slug>` 單一形（#122——
 * slug 恆為字串，舊三態已退役）。
 * 無刪除鈕——刪除移到內文卡頁頭的 ⋮ 選單（`NoteMenu.tsx`）。
 */
export function NoteList({ query }: NoteListProps) {
  const { t } = useTranslation();
  const notesQuery = useNotes();

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
  if (notes.length === 0) {
    return <EmptyState title={t("home.empty")} description={t("home.emptyDescription")} />;
  }

  const recent = notes.slice(0, 2);
  const myNotes = notes.filter((note) => note.role === "owner");
  const shared = notes.filter((note) => note.role === "editor" || note.role === "viewer");

  const lowerQuery = (query ?? "").toLowerCase();
  const matchesQuery = (note: NoteDto) => note.title.toLowerCase().includes(lowerQuery);

  const filteredRecent = recent.filter(matchesQuery);
  const filteredMyNotes = myNotes.filter(matchesQuery);
  const filteredShared = shared.filter(matchesQuery);

  if (filteredRecent.length === 0 && filteredMyNotes.length === 0 && filteredShared.length === 0) {
    return <p className="p-2 text-sm text-muted-foreground">{t("sidebar.noMatch")}</p>;
  }

  return (
    <>
      <NoteGroup testId="notegroup-recent" label={t("sidebar.recent")} notes={filteredRecent} primary={false} />
      <NoteGroup testId="notegroup-myNotes" label={t("sidebar.myNotes")} notes={filteredMyNotes} primary />
      <NoteGroup testId="notegroup-shared" label={t("sidebar.shared")} notes={filteredShared} primary />
    </>
  );
}
