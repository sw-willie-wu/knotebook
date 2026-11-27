import "@/i18n/comments-strings";
import { useTranslation } from "react-i18next";
import type { CommentDto } from "@knotebook/shared";
import { Avatar } from "@/components/Avatar";
import { CornerDownRight } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { CommentBody } from "./CommentBody";
import { authorName, fullTime, relativeTime } from "./comment-format";

export interface CommentItemProps {
  comment: CommentDto;
  /** Null while the document's blocks aren't known yet: the quote then stays clickable. */
  blockIds: Set<string> | null;
  highlighted: boolean;
  onQuote: (blockId: string) => void;
  onReplySummary: (commentId: string) => void;
  onReply: (comment: CommentDto) => void;
  onEdit: (comment: CommentDto) => void;
  onDelete: (comment: CommentDto) => void;
}

const ACTION = "rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground pointer-coarse:px-2.5 pointer-coarse:py-2";

export function CommentItem({ comment, blockIds, highlighted, onQuote, onReplySummary, onReply, onEdit, onDelete }: CommentItemProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const who = authorName(comment);
  const agent = comment.agentLabel !== null;
  const anchor = comment.anchor;
  const passageGone = anchor !== null && blockIds !== null && !blockIds.has(anchor.blockId);

  return (
    <li
      data-testid="comment"
      data-comment-id={comment.id}
      className={cn("flex gap-2 rounded-md px-2 py-2 transition-colors duration-700", highlighted && "bg-brand-soft")}
    >
      <Avatar name={agent ? comment.authorHandle : who} avatar={comment.authorAvatar} size={28} kind={agent ? "agent" : "user"} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span data-testid="comment-author" className={cn("font-semibold text-sm", agent && "text-[#7c3aed] dark:text-[#a78bfa]")}>
            {who}
          </span>
          <time dateTime={comment.createdAt} title={fullTime(comment.createdAt, lang)} className="text-muted-foreground">
            {relativeTime(comment.createdAt, lang)}
          </time>
          {comment.editedAt !== null && (
            <span data-testid="comment-edited" title={t("comments.editedAt", { when: fullTime(comment.editedAt, lang) })} className="text-muted-foreground">
              ({t("comments.edited")})
            </span>
          )}
        </div>
        {comment.replyToId !== null &&
          (comment.replyTo !== null ? (
            <button
              type="button"
              data-testid="comment-reply-summary"
              aria-label={t("comments.replyJump", { who: comment.replyTo.authorHandle })}
              onClick={() => onReplySummary(comment.replyTo!.id)}
              className="flex w-full min-w-0 items-center gap-1 rounded text-left text-xs text-muted-foreground hover:text-foreground"
            >
              <CornerDownRight aria-hidden="true" className="h-3 w-3 shrink-0" />
              <span className="shrink-0 font-medium">@{comment.replyTo.authorHandle}</span>
              <span className="min-w-0 truncate">{comment.replyTo.excerpt}</span>
            </button>
          ) : (
            <p data-testid="comment-reply-deleted" className="flex items-center gap-1 text-xs italic text-muted-foreground">
              <CornerDownRight aria-hidden="true" className="h-3 w-3 shrink-0" />
              {t("comments.answeredDeleted")}
            </p>
          ))}
        {anchor !== null &&
          (passageGone ? (
            <p data-testid="comment-quote" data-passage-deleted="" className="rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">
              <span className="block font-medium">{t("comments.passageDeleted")}</span>
              {anchor.quote !== null && <span className="line-clamp-2 line-through">{anchor.quote}</span>}
            </p>
          ) : (
            <button
              type="button"
              data-testid="comment-quote"
              title={t("comments.quoteJump")}
              onClick={() => onQuote(anchor.blockId)}
              className="block w-full rounded-md border border-border bg-brand-soft px-2 py-1 text-left text-xs hover:bg-brand-soft-strong"
            >
              <span className="line-clamp-2">{anchor.quote ?? t("comments.passage")}</span>
            </button>
          ))}
        <CommentBody body={comment.body} mentions={comment.mentions} />
        <div role="group" aria-label={t("comments.actionsFor", { who })} className="-ml-1.5 flex gap-1">
          <button type="button" className={ACTION} onClick={() => onReply(comment)}>
            {t("comments.reply")}
          </button>
          {comment.canEdit && (
            <button type="button" data-action="edit" className={ACTION} onClick={() => onEdit(comment)}>
              {t("comments.edit")}
            </button>
          )}
          {comment.canDelete && (
            <button type="button" className={cn(ACTION, "hover:text-destructive")} onClick={() => onDelete(comment)}>
              {t("comments.delete")}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
