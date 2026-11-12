import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Awareness } from "y-protocols/awareness";
import type { CursorScroller } from "@/collab/cursor-scroll";
import { Avatar } from "@/components/Avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createLongPress } from "@/lib/long-press";
import { cn } from "@/lib/utils";
import { hasVisibleText, presenceLayout, type PresenceKey, type PresencePerson } from "./people";
import { usePresencePeople } from "./usePresencePeople";

export interface PresenceAvatarsProps {
  provider: { awareness?: Awareness | null } | null;
  /** `state.phase === "connected"`。 */
  connected: boolean;
  myUserId: string;
  scrollerRef: { readonly current: CursorScroller | null };
}

type Opener = PresenceKey | "more";

/**
 * 三種形（頁頭是 container）：
 * - 視窗 `< 640`（`max-sm`）：精簡形，不放頭像，只有一顆「+N」（N＝所有其他人）。
 * - 視窗 `>= 640` 且頁頭 container `< 43.5rem`：窄形，最多 2 格。
 * - 其餘：寬形，最多 5 格。
 * 藏的方式是 `display:none`（不是 DOM 裡少一份），所以最多三顆「+N」同時存在、各自帶自己那組 class。
 */
/** 寬形才顯示（視窗 `< 640` 或頁頭 container `< 43.5rem` 任一成立就藏；同頁頭寬度鈕的門檻）。 */
const WIDE_ONLY = "max-sm:hidden @max-[43.5rem]:hidden";
/** 窄形才顯示（手機寬藏；視窗夠寬時 container 夠寬也藏）。 */
const NARROW_ONLY = "max-sm:hidden sm:@min-[43.5rem]:hidden";
/** 精簡形才顯示（只在手機寬）。 */
const COMPACT_ONLY = "sm:hidden";
/** 頭像在手機寬一律藏（只剩精簡 +N）；窄形留下的頭像在 640 以上不藏。 */
const PHONE_HIDDEN = "max-sm:hidden";
/**
 * 點擊區以 `::before` 擴大，版面高度不變：預設 32×32 px，觸控裝置（`pointer-coarse`）36×44 px；聚焦／hover 的那顆浮到上層，焦點框不被下一顆蓋住。
 * #335：頭像 24 px、疊放 `-ms-1.5`（6 px）時，下一顆的 `::before` 往左伸出量（x 方向）必須 ≤ 6 px，否則會蓋住前一顆的中心點
 * （Playwright 的 `hover()` 會一直被攔截而卡死；觸控也會點到鄰居）。所以 x、y 分開擴：x 受疊放限制（預設 4 px、觸控 6 px），
 * y 沒有鄰居，觸控裝置可放到 10 px 以維持 44 px 的觸控高度。
 */
const HIT_BASE =
  "relative inline-flex rounded-full outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "hover:z-10 before:absolute before:content-['']";
const HIT = `${HIT_BASE} before:-inset-x-1 before:-inset-y-1 pointer-coarse:before:-inset-x-1.5 pointer-coarse:before:-inset-y-2.5`;
/** 精簡 +N 視覺 32×28、點擊區 40×44；它在手機寬時是列裡唯一看得見的鈕，沒有鄰居要避開。 */
const HIT_COMPACT = `${HIT_BASE} before:-inset-x-1 before:-inset-y-2`;

/** 還焦點的目標要真的看得見：寬窄模式的藏法是 `display:none`，對它 `focus()` 會無聲失敗。 */
function focusable(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && getComputedStyle(el).display !== "none";
}

/** 使用者自填的字串（名字、token 標籤）以 `<bdi>` 隔離並截斷；翻譯樣板的其餘部分照原樣。 */
const SLOT_OPEN = String.fromCharCode(0xe000);
const SLOT_CLOSE = String.fromCharCode(0xe001);
const slot = (i: number) => `${SLOT_OPEN}${i}${SLOT_CLOSE}`;
const SLOT_RE = new RegExp(`${SLOT_OPEN}(\\d)${SLOT_CLOSE}`);

function isolated(template: string, values: readonly string[]): ReactNode {
  const parts = template.split(SLOT_RE);
  return (
    <span className="flex min-w-0 max-w-full">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <bdi key={i} className="min-w-0 truncate">
            {values[Number(part)]}
          </bdi>
        ) : part === "" ? null : (
          <span key={i} className="shrink-0 whitespace-pre">
            {part}
          </span>
        ),
      )}
    </span>
  );
}

/** 名字沒有看得見的字（空白、只有格式字元）時用 `?`（同首字圓），不讓名稱以「，檢視者」開頭。 */
function shownName(p: Extract<PresencePerson, { kind: "user" }>): string {
  return hasVisibleText(p.name) ? p.name : "?";
}

function ariaLabel(t: TFunction, p: PresencePerson): string {
  if (p.kind === "agent") {
    return t(p.hasCursor ? "note.presence.agentCursor" : "note.presence.agentNoCursor", { handle: p.handle, label: p.label });
  }
  const name = shownName(p);
  if (p.role === null) return t(p.hasCursor ? "note.presence.avatarNameCursor" : "note.presence.avatarNameNoCursor", { name });
  return t(p.hasCursor ? "note.presence.avatarCursor" : "note.presence.avatarNoCursor", { name, role: t(`roles.${p.role}`) });
}

function tipTitle(t: TFunction, p: PresencePerson): ReactNode {
  if (p.kind === "agent") return isolated(t("note.presence.tipAgent", { handle: slot(0), label: slot(1) }), [p.handle, p.label]);
  const name = shownName(p);
  if (p.role === null) return isolated(slot(0), [name]);
  return isolated(t("note.presence.tipRole", { name: slot(0), role: t(`roles.${p.role}`) }), [name]);
}

function tipHint(t: TFunction, p: PresencePerson): string {
  if (!p.hasCursor) return t("note.presence.hintNoCursor");
  return t(p.kind === "agent" ? "note.presence.hintCursorAgent" : "note.presence.hintCursor");
}

function rowName(p: PresencePerson): string {
  return p.kind === "agent" ? `${p.handle} (${p.label})` : shownName(p);
}

function rowRole(t: TFunction, p: PresencePerson): string {
  if (p.kind === "agent") return t("note.presence.agent");
  return p.role === null ? "" : t(`roles.${p.role}`);
}

function PersonAvatar({ person, size, offsetColor }: { person: PresencePerson; size: number; offsetColor?: string }) {
  return person.kind === "agent" ? (
    <Avatar name={person.handle} avatar={null} size={size} ringColor={person.color} offsetColor={offsetColor} kind="agent" />
  ) : (
    <Avatar name={person.name} avatar={person.avatar} size={size} ringColor={person.color} offsetColor={offsetColor} />
  );
}

interface PersonButtonProps {
  person: PresencePerson;
  className: string;
  suppressed: boolean;
  onUnsuppress: () => void;
  onScroll: () => void;
  onLongPress: (el: HTMLElement | null) => void;
}

function PersonButton({ person, className, suppressed, onUnsuppress, onScroll, onLongPress }: PersonButtonProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  // 受控：Radix 的開關意圖照收，抑制只遮住顯示。
  const [tipOpen, setTipOpen] = useState(false);
  const longPressRef = useRef(onLongPress);
  longPressRef.current = onLongPress;
  const [press] = useState(() => createLongPress(() => longPressRef.current(buttonRef.current)));
  useEffect(() => () => press.dispose(), [press]);

  return (
    <Tooltip open={tipOpen && !suppressed} onOpenChange={setTipOpen}>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <button
          ref={buttonRef}
          data-person-key={person.key}
          type="button"
          aria-label={ariaLabel(t, person)}
          className={cn(HIT, className)}
          onClick={() => {
            if (press.consumeClick()) return;
            onScroll();
          }}
          onPointerDown={(e) => {
            // 抑制中 Radix 的 pointerdown 不 onClose（`open` prop 已是 false），tipOpen 要自己關。
            onUnsuppress();
            setTipOpen(false);
            press.down(e);
          }}
          onPointerMove={(e) => press.move(e)}
          onPointerUp={() => press.end()}
          onPointerCancel={() => press.end()}
          onContextMenu={(e) => {
            if (press.contextMenu()) e.preventDefault();
          }}
          onKeyDown={onUnsuppress}
          onBlur={() => {
            // 同上：抑制中 Radix 的 blur 關閉不會呼叫 onOpenChange。
            onUnsuppress();
            setTipOpen(false);
          }}
        >
          <PersonAvatar person={person} size={24} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div>{tipTitle(t, person)}</div>
        <div className="text-muted-foreground">{tipHint(t, person)}</div>
      </TooltipContent>
    </Tooltip>
  );
}

function MoreButton({
  count,
  expanded,
  className,
  compact = false,
  onOpen,
}: {
  count: number;
  expanded: boolean;
  className: string;
  compact?: boolean;
  onOpen: (el: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t("note.presence.more", { count })}
      aria-haspopup="menu"
      aria-expanded={expanded}
      className={cn(
        compact ? `${HIT_COMPACT} h-7 w-8 max-sm:ms-0!` : `${HIT} h-6 w-6`,
        "items-center justify-center bg-muted text-xs font-semibold text-foreground",
        className,
      )}
      onClick={(e) => onOpen(e.currentTarget)}
    >
      +{count}
    </button>
  );
}

/**
 * #293：頁頭頭像列。只有我、或非 connected → 不渲染任何節點。不加 `aria-live`。
 * 選單的 Trigger 是不包住任何頭像的隱藏兄弟節點；選單只由 +N 與長按以受控 `open` 打開。
 */
export function PresenceAvatars({ provider, connected, myUserId, scrollerRef }: PresenceAvatarsProps) {
  const { t } = useTranslation();
  const { people, cursorOf } = usePresencePeople(connected ? (provider?.awareness ?? null) : null, myUserId);
  const [menu, setMenu] = useState<Opener | null>(null);
  // 開它的那顆：關閉時 Radix 在 setTimeout(0) 才呼叫 onCloseAutoFocus，讀 ref 才是最新值。
  const openerRef = useRef<{ opener: Opener; el: HTMLElement | null } | null>(null);
  const [suppressedKey, setSuppressedKey] = useState<PresenceKey | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const visible = connected && people.length > 0;

  useEffect(() => {
    if (!visible) setMenu(null);
  }, [visible]);

  if (!visible) return null;

  const layout = presenceLayout(people.length);
  const title = t("note.presence.menuTitle", { count: people.length });
  const openMenu = (opener: Opener, el: HTMLElement | null) => {
    openerRef.current = { opener, el };
    setMenu(opener);
  };
  const scrollTo = (key: PresenceKey) => {
    const cursor = cursorOf(key);
    if (cursor !== null) scrollerRef.current?.(cursor);
  };
  const unsuppress = () => setSuppressedKey(null);
  // `onOpenAutoFocus` 是 Radix Menu 2.1.24 的私有 prop：DropdownMenu 的型別沒公開，執行期原樣傳到 FocusScope
  // （`react-menu dist/index.mjs:179`、`:266`）。長按聚焦到該列靠它；升 Radix 後對應的測試會先紅。
  const openAutoFocus: object = {
    onOpenAutoFocus: (e: Event) => {
      const opener = openerRef.current?.opener;
      if (opener === undefined || opener === "more") return;
      e.preventDefault();
      const rows = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-person-key]");
      [...rows].find((row) => row.dataset.personKey === opener)?.focus();
    },
  };

  return (
    <TooltipProvider delayDuration={300}>
      {/* 疊放用 `[&>button+button]:-ms-1.5`（margin 在後一顆身上），不用 `-space-x-1.5`：被藏的窄模式 +N
          常是最後一個 DOM 子節點，後者會讓最後一顆可見頭像也拿到 −6 px。隱藏 Trigger 放第一個子節點。 */}
      <div
        ref={groupRef}
        role="group"
        aria-label={t("note.presence.label")}
        className="relative flex shrink-0 items-center [&>button+button]:-ms-1.5"
      >
        <DropdownMenu
          open={menu !== null}
          onOpenChange={(o) => {
            if (!o) setMenu(null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <span aria-hidden="true" tabIndex={-1} className="pointer-events-none absolute inset-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label={title}
            aria-labelledby={undefined}
            className="max-w-72"
            {...openAutoFocus}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const current = openerRef.current;
              openerRef.current = null;
              if (current === null) return;
              // 開它的那顆已離開或被藏（寬窄切換）→ 退到列裡第一顆看得見的鈕。
              const buttons = [...(groupRef.current?.querySelectorAll<HTMLElement>("button") ?? [])];
              const target = focusable(current.el) ? current.el : buttons.find(focusable);
              if (!target) return;
              // 長按開的（觸控）：抑制實際拿到焦點的那顆頭像的 Tooltip。
              const key = target.dataset.personKey as PresenceKey | undefined;
              if (current.opener !== "more" && key) setSuppressedKey(key);
              target.focus({ preventScroll: true });
            }}
          >
            <DropdownMenuLabel>{title}</DropdownMenuLabel>
            {people.map((p) => (
              <DropdownMenuItem
                key={p.key}
                data-person-key={p.key}
                // 沒有游標的列不用 `disabled`：Radix 會把它從方向鍵巡覽拿掉（含螢幕閱讀器在選單裡逐項移動），而且畫成淡色。
                // 改用 `aria-disabled`：仍可聚焦與朗讀，選取時不捲動、選單也不關。
                aria-disabled={p.hasCursor ? undefined : true}
                className="gap-2"
                onSelect={(e) => {
                  if (!p.hasCursor) {
                    e.preventDefault();
                    return;
                  }
                  scrollTo(p.key);
                }}
              >
                <PersonAvatar person={p} size={24} offsetColor="var(--color-popover)" />
                <bdi className="min-w-0 flex-1 truncate">{rowName(p)}</bdi>{" "}
                <span className="shrink-0 ps-2 text-xs text-muted-foreground">{rowRole(t, p)}</span>
                {!p.hasCursor && (
                  <>
                    {" "}
                    <span className="shrink-0 text-xs text-muted-foreground">{t("note.presence.rowNoCursor")}</span>
                  </>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {people.slice(0, layout.wide.shown).map((p, i) => (
          <PersonButton
            key={p.key}
            person={p}
            className={i < layout.narrow.shown ? PHONE_HIDDEN : WIDE_ONLY}
            suppressed={suppressedKey === p.key}
            onUnsuppress={unsuppress}
            onScroll={() => scrollTo(p.key)}
            onLongPress={(el) => openMenu(p.key, el)}
          />
        ))}
        {layout.wide.more > 0 && (
          <MoreButton
            count={layout.wide.more}
            expanded={menu === "more"}
            className={WIDE_ONLY}
            onOpen={(el) => openMenu("more", el)}
          />
        )}
        {layout.narrow.more > 0 && (
          <MoreButton
            count={layout.narrow.more}
            expanded={menu === "more"}
            className={NARROW_ONLY}
            onOpen={(el) => openMenu("more", el)}
          />
        )}
        {layout.compact.more > 0 && (
          <MoreButton
            count={layout.compact.more}
            expanded={menu === "more"}
            className={COMPACT_ONLY}
            compact
            onOpen={(el) => openMenu("more", el)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
