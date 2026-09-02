import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, ApiFail } from "@/api/client";
import { decodePublicYdoc } from "@/collab/public-doc";
import { PublicNoteEditor } from "@/components/PublicNoteEditor";
import { PublicPageFrame } from "@/components/PublicNoteShell";
import { publicNoteApiPath, publicNoteQueryKey, type PublicNoteRef } from "@/lib/public-note-ref";
import { ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING } from "@/components/ui/article-column";
import { cn } from "@/lib/utils";

/** 公開內容端點的回應形（server 端 routes/public.ts，兩形同形；刻意不含 noteId／updatedAt）。 */
interface PublicNoteDto {
  title: string;
  ydoc: string;
}

/**
 * 公開唯讀頁（#72 Task 3；#122 PR3 起雙形）：`/p/:token` 與 `/p/:handle/:slug`
 * 共用本頁。**免登入**：兩條路由都掛在 RequireAuth 外（App.tsx），整頁零 auth
 * 相依——不打 `/api/auth/me`、不掛 AppShell、不掛 useCollab（內容是快照，落後
 * 量級 debounce 2s／上限 10s，記 known-limitations）。
 *
 * 形的判別走 useParams（比照 NotePage 的 isPathForm 慣例）：`handle`＋`slug` 都在
 * ＝雙段別名形，否則單段 token 形；API 路徑與 query key 都依形分岔
 * （lib/public-note-ref.ts——兩形不得共 key）。
 *
 * 格式驗證與 404 同形都在 server 端（routes/public.ts 的四步序）；這裡只分兩種
 * 失敗呈現：404 → 失效卡（撤銷／改名／別名清除後的舊連結，同形不可區分），
 * 其餘 → errors.<code> 文案（429 節流時連結可能還活著，不能誤告「已失效」）。
 */
export default function PublicNotePage() {
  const params = useParams<{ token?: string; handle?: string; slug?: string }>();
  const { t } = useTranslation();

  // 與 NotePage 的 isPathForm 同名同判準（可 grep 的慣例錨點）
  const isPathForm = params.handle !== undefined && params.slug !== undefined;
  const publicRef: PublicNoteRef = useMemo(
    () =>
      isPathForm
        ? { kind: "path", handle: params.handle!, slug: params.slug! }
        : { kind: "token", token: params.token ?? "" },
    [isPathForm, params.token, params.handle, params.slug],
  );
  const enabled = publicRef.kind === "path" || publicRef.token.length > 0;

  const query = useQuery({
    queryKey: publicNoteQueryKey(publicRef),
    queryFn: () => api<PublicNoteDto>(publicNoteApiPath(publicRef)),
    enabled,
    // 不重試：404 是這個端點最常見的合法結果（撤銷後的連結），預設的三連重試只會
    // 多啃節流額度（miss 桶 key=ip）、把失效卡的出現拖慢好幾秒。
    retry: false,
  });

  // 解碼放 render（useMemo）而不是 queryFn：毀損 payload 的 throw 會冒到
  // PublicNoteErrorBoundary 顯示錯誤卡＋重試，而不是被 react-query 當成「查詢失敗」
  // 吃進 error 態誤標成連結問題。
  const doc = useMemo(() => (query.data ? decodePublicYdoc(query.data.ydoc) : null), [query.data]);

  // 背景 refetch（react-query 預設 focus/reconnect 會重抓）失敗的呈現規則（讀碼審查
  // 抓到的皺褶）：404 → **翻成失效卡**，即使手上還有內容——這是撤銷的即時傳播，正在
  // 看的人回到分頁就該知道連結死了；**非 404 且已有內容 → 繼續渲染既有快照**——
  // 一時的網路失敗不該把看到一半的內容整卡換成錯誤文案（query.data 在 refetch 失敗
  // 時仍保留），下次 refetch 成功自癒。
  const notFound = query.isError && query.error instanceof ApiFail && query.error.status === 404;

  let body: ReactNode;
  if (query.isPending) {
    body = <p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>;
  } else if (notFound) {
    body = (
      <p role="alert" className="p-6 text-sm text-muted-foreground">
        {t("public.invalidLink")}
      </p>
    );
  } else if (query.isError && !query.data) {
    body = (
      <p role="alert" className="p-6 text-sm text-destructive">
        {query.error instanceof ApiFail
          ? t(`errors.${query.error.code}`, { defaultValue: t("errors.fallback") })
          : t("errors.fallback")}
      </p>
    );
  } else {
    // 此分支 query.data 必有（pending／notFound／「錯誤且無資料」都在上面排除），
    // 但 TS 的判別式聯集跟不上自訂分支，只好斷言。
    const data = query.data!;
    body = (
      <>
        {/* 單卡頁首：標題＋唯讀徽章＋Knotebook 字樣連回 /（匿名者點了會被 RequireAuth
            導去 /login——那就是這顆連結的用途：從分享頁通往產品本身）。 */}
        <header className="flex items-center gap-3 border-b border-border px-5 py-3">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{data.title}</h1>
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {t("public.readonly")}
          </span>
          <Link to="/" className="shrink-0 text-sm font-semibold text-brand">
            Knotebook
          </Link>
        </header>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {/* 內文沿 NoteEditor 的文章欄常數（#115：`<md` 內距 70→20 的斷點機制在
              article-column.ts／index.css，這裡照吃不另寫）。 */}
          <div className={cn(ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING, "flex min-h-full flex-col py-6")}>
            <PublicNoteEditor doc={doc!} publicRef={publicRef} />
          </div>
        </div>
      </>
    );
  }

  return <PublicPageFrame>{body}</PublicPageFrame>;
}
