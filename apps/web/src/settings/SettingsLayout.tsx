import type { ReactNode } from "react";

/**
 * 說明段落的共用排版：`max-w-prose`（65ch）限寬、左右對齊。
 *
 * `text-justify` 配 `max-w-prose` 才成立——不限寬的左右對齊在寬欄位上會把字距
 * 拉出明顯的「河流」。`hyphens-auto` 是給英文的（`index.html` 宣告 `lang="en"`，
 * 瀏覽器據此斷字）：沒有斷字的英文左右對齊，每行尾端的空隙會大到刺眼；中文不斷字，
 * 這條對它無作用也無害。
 */
const PROSE = "max-w-prose text-justify hyphens-auto";

/**
 * 設定面板的版面語彙（`/settings/*` 三個區塊共用）。
 *
 * 解的是「沒有層次感、項次內容都黏在一起」：改版前每個區塊都是一串同級的
 * `h1`/`h2` ＋灰色說明 ＋控制項，彼此只靠 24px 空白隔開，而 modal 標題（14px）
 * 比區塊標題（18px）還小——型階是倒的，分群沒有任何視覺載體。
 *
 * 型階（由大到小）：頁標題 20px ／ 群組標題 16px ／ 說明與內文 14px ／
 * 導覽品牌字 13px。四級各自可辨，不靠粗細硬撐。
 *
 * 分群用**髮絲線＋留白**，不用卡片：這個 modal 本身已經是一張浮層卡，
 * 群組再各包一張會變成卡中卡，而且會把「一頁設定」讀成「一堆不相干的東西」。
 */

/**
 * 一個 `/settings/*` 區塊的頁首＋群組容器。
 *
 * `action` 放在標題列右側時要留出 ✕ 關閉鈕的位置——`DialogContent` 的關閉鈕是
 * `absolute right-4 top-4`，內容區的 `p-8` 只擦邊擋得住，所以標題列多給 `pr-6`。
 *
 * `divide-y` 讓群組之間長出髮絲線（第一個不長），群組自己負責上下留白。
 */
export function SettingsPage({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <header className="flex items-start justify-between gap-4 pr-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description !== undefined && (
            // 限寬＋左右對齊：見上方 PROSE
            <p className={`${PROSE} text-sm text-muted-foreground`}>{description}</p>
          )}
        </div>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </header>
      <div className="mt-8 divide-y divide-border">{children}</div>
    </div>
  );
}

/**
 * 一個設定群組＝**一件事**（使用者名／API token／密碼／AI 供應商…）。
 *
 * `action` 刻意放在群組自己的標題列，不浮在內容上方：這樣才看得出來
 * 「建立 token」屬於 API token 這一組、而不是屬於整頁。
 *
 * `title` 可省略（例如 SSO-only 帳號那段提示沒有自己的標題，而且
 * `SettingsAccountSection.test.tsx` 明文要求那時不得出現「修改密碼」標題）。
 */
export function SettingsGroup({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const hasHeader = title !== undefined || description !== undefined || action !== undefined;
  return (
    <section className="py-8 first:pt-0 last:pb-0">
      {hasHeader && (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            {title !== undefined && <h2 className="text-base font-semibold">{title}</h2>}
            {description !== undefined && (
              <p className={`${PROSE} text-sm text-muted-foreground`}>{description}</p>
            )}
          </div>
          {action !== undefined && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children !== undefined && <div className={hasHeader ? "mt-4" : undefined}>{children}</div>}
    </section>
  );
}
