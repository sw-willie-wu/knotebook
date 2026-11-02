import "@/i18n/shortcuts-strings";
import { Fragment, useId, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { fetchAiActions } from "@/api/ai";
import { isMacPlatform } from "@/lib/platform";
import { visibleShortcuts, type KeyToken, type ShortcutEntry, type ShortcutKeys } from "./shortcut-list";

/**
 * 快捷鍵介紹頁的內容（lazy chunk，第一次打開才下載；外殼見 `ShortcutsDialog`）。
 *
 * 清單資料在 `shortcut-list.ts`，字串在 `i18n/shortcuts.*.json`（由上面那行 import 註冊）。站台能力（K8）：
 * `["ai-actions"]` 查詢有資料才列 AI 段；有 `kind === "instruct"` 的動作才列「送出指令」。載入中、錯誤、空陣列一律視為都沒有。
 *
 * 鍵面（K9）：Mac 顯示 ⌘ ⇧ ⌥，其他平台 Ctrl Shift Alt。符號鍵 `aria-hidden`、旁邊放 sr-only 名稱（報讀器讀不出 ⌘ ⇧ ↑ 的意義）；
 * 組合鍵之間的「+」與多種按法之間的「／」也 `aria-hidden`，旁邊的 sr-only 依條目的 `sep` 讀「或」（同一件事的不同按法）
 * 或「、」（各是不同動作）。
 *
 * PR-A 的「重看導覽」鈕加在最下面 `<div data-shortcuts-footer>` 裡、提示句的右側（本 PR 不放，D8）。
 */

type TFn = (key: string) => string;

/** 符號鍵：可見的是符號（aria-hidden），旁邊放給報讀器的名稱。 */
function SymbolKey({ symbol, name }: { symbol: string; name: string }) {
  return (
    <>
      <span aria-hidden="true">{symbol}</span>
      <span className="sr-only">{name}</span>
    </>
  );
}

function keyLabel(token: KeyToken, mac: boolean, t: TFn): ReactNode {
  switch (token) {
    case "Mod":
      return mac ? <SymbolKey symbol="⌘" name={t("shortcutsGuide.srKeys.command")} /> : "Ctrl";
    case "Shift":
      return mac ? <SymbolKey symbol="⇧" name={t("shortcutsGuide.srKeys.shift")} /> : "Shift";
    case "Alt":
      return mac ? <SymbolKey symbol="⌥" name={t("shortcutsGuide.srKeys.option")} /> : "Alt";
    case "ArrowUp":
      return <SymbolKey symbol="↑" name={t("shortcutsGuide.srKeys.up")} />;
    case "ArrowDown":
      return <SymbolKey symbol="↓" name={t("shortcutsGuide.srKeys.down")} />;
    case "ArrowLeft":
      return <SymbolKey symbol="←" name={t("shortcutsGuide.srKeys.left")} />;
    case "ArrowRight":
      return <SymbolKey symbol="→" name={t("shortcutsGuide.srKeys.right")} />;
    case "Space":
      return t("shortcutsGuide.keys.space");
    case "Enter":
      return t("shortcutsGuide.keys.enter");
    case "Esc":
      return t("shortcutsGuide.keys.esc");
    case "Tab":
      return t("shortcutsGuide.keys.tab");
    case "Backspace":
      return t("shortcutsGuide.keys.backspace");
    case "Delete":
      return t("shortcutsGuide.keys.delete");
    case "Click":
      return t("shortcutsGuide.keys.click");
    default:
      return token;
  }
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-muted px-1.5 font-mono text-xs">{children}</kbd>;
}

function Plus() {
  return (
    <span aria-hidden="true" className="px-0.5 text-xs text-muted-foreground">
      +
    </span>
  );
}

/** 同時按的一組鍵：每個 token 一個 <kbd>，之間以 aria-hidden 的「+」連接。 */
function Combo({ keys, mac, t }: { keys: readonly KeyToken[]; mac: boolean; t: TFn }) {
  return (
    <>
      {keys.map((token, index) => (
        <Fragment key={index}>
          {index > 0 && <Plus />}
          <Kbd>{keyLabel(token, mac, t)}</Kbd>
        </Fragment>
      ))}
    </>
  );
}

/** 一個按法；`withSpace` 為 true 時（打字觸發字後面要接空白）後面接 Space 鍵。 */
function OneKeys({ keys, mac, t, withSpace }: { keys: ShortcutKeys; mac: boolean; t: TFn; withSpace: boolean }) {
  if (keys.kind === "combo") return <Combo keys={keys.keys} mac={mac} t={t} />;
  if (keys.kind === "typed") {
    return (
      <>
        <Kbd>{keys.text}</Kbd>
        {withSpace && (
          <>
            <Plus />
            <Kbd>{keyLabel("Space", mac, t)}</Kbd>
          </>
        )}
      </>
    );
  }
  return null;
}

/** 一條的所有按法，多種按法之間放分隔（K9）。 */
function EntryKeys({ entry, mac, t }: { entry: ShortcutEntry; mac: boolean; t: TFn }) {
  const list = mac && entry.macKeys ? entry.macKeys : entry.keys;
  if (list.every((k) => k.kind === "action")) return null;
  // 每一種打字觸發字後面都要接空白時，只在最後放一個 Space，避免畫面上一排重複的 Space
  const sharedSpace = list.every((k) => k.kind === "typed" && k.thenSpace === true);
  const sepName = entry.sep === "pair" ? t("shortcutsGuide.srKeys.pair") : t("shortcutsGuide.srKeys.or");
  return (
    <>
      {list.map((keys, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <>
              <span aria-hidden="true" className="px-0.5 text-xs text-muted-foreground">
                ／
              </span>
              <span className="sr-only">{sepName}</span>
            </>
          )}
          <OneKeys keys={keys} mac={mac} t={t} withSpace={!sharedSpace && keys.kind === "typed" && keys.thenSpace === true} />
        </Fragment>
      ))}
      {sharedSpace && (
        <>
          <Plus />
          <Kbd>{keyLabel("Space", mac, t)}</Kbd>
        </>
      )}
    </>
  );
}

export function ShortcutsContent() {
  const { t } = useTranslation();
  const mac = isMacPlatform();
  const uid = useId();
  const ai = useQuery({ queryKey: ["ai-actions"], queryFn: fetchAiActions });
  const actions = ai.data ?? [];
  const groups = visibleShortcuts({ aiAvailable: actions.length > 0, aiInstruct: actions.some((a) => a.kind === "instruct") });
  const tt: TFn = (key) => t(key);

  return (
    <div className="flex flex-col gap-6 pb-2 pt-1">
      {groups.map(({ category, entries }) => {
        const headingId = `${uid}-${category}`;
        return (
          <section key={category} aria-labelledby={headingId} data-shortcut-category={category}>
            <h3 id={headingId} className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
              {t(`shortcutsGuide.categories.${category}`)}
            </h3>
            <ul className="divide-y divide-border">
              {entries.map((entry) => (
                <li key={entry.id} data-shortcut-id={entry.id} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:gap-4">
                  <div className="flex shrink-0 flex-wrap items-center gap-1 sm:w-56">
                    <EntryKeys entry={entry} mac={mac} t={tt} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t(`shortcutsGuide.items.${entry.id}.name`)}</p>
                    <p className="text-sm text-muted-foreground">{t(`shortcutsGuide.items.${entry.id}.desc`)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {/* PR-A 的「重看導覽」鈕加在這個 div 裡、提示句的右側（variant="outline"）。 */}
      <div data-shortcuts-footer className="flex flex-wrap items-center gap-3 border-t border-border pt-4 text-sm text-muted-foreground">
        <p>
          <Trans
            i18nKey="shortcutsGuide.footer"
            components={{
              keys: (
                <span className="inline-flex items-center gap-1 align-middle">
                  <Combo keys={["Mod", "/"]} mac={mac} t={tt} />
                </span>
              ),
            }}
          />
        </p>
      </div>
    </div>
  );
}
