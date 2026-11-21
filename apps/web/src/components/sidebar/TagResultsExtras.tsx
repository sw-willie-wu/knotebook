import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useGroups } from "@/api/groups";
import { useNotes } from "@/api/notes";
import "@/i18n/tags-strings";
import { TagDot } from "@/components/tags/TagDot";
import type { SearchTagToken } from "./search-tags";
import { addToken, filterableTagSpaces, reconcileTokens, spaceKeyOf, tokenFromTag } from "./search-tags-logic";

/**
 * Lazy (initial-bundle cap), mounted while there are tag tokens under the search box.
 * Keeps the tokens honest: a tag deleted, merged or emptied elsewhere leaves the note list on its next refetch, and its token is dropped here; renames are taken over.
 * Also draws the result count line (the wording with the tag names lives here, off the first bundle) and the "Add:" row with the other tags of the token's space.
 */
export default function TagResultsExtras({
  tagTokens,
  onTagTokensChange,
  plainStatus,
  gateOff,
  titleCount,
  body,
}: {
  tagTokens: readonly SearchTagToken[];
  onTagTokensChange?: (tokens: SearchTagToken[]) => void;
  /** The count line without tag names. */
  plainStatus: string;
  /** No body search runs (text too short): the count is the notes carrying the tags. */
  gateOff: boolean;
  titleCount: number;
  /** Row count of the loaded body results, null while they are not ready. */
  body: { count: number; more: boolean } | null;
}) {
  const { t } = useTranslation();
  const notes = useNotes().data;
  const groups = useGroups().data;
  const spaces = useMemo(() => filterableTagSpaces(notes ?? [], groups ?? []), [notes, groups]);
  useEffect(() => {
    if (notes === undefined || groups === undefined) return;
    const next = reconcileTokens(tagTokens, spaces);
    if (next !== tagTokens) onTagTokensChange?.([...next]);
  }, [tagTokens, spaces, notes, groups, onTagTokensChange]);
  const first = tagTokens[0];
  if (first === undefined) return null;
  const addable = (spaces.find((entry) => spaceKeyOf(entry.space) === spaceKeyOf(first.space))?.tags ?? []).filter((tag) => !tagTokens.some((token) => token.id === tag.id));
  const space = first.space.kind === "personal" ? t("sidebar.myNotes") : first.space.groupName;
  const names = tagTokens.map((token) => token.name).join(t("tagSearch.joiner"));
  let status = plainStatus;
  if (gateOff) status = t("tagSearch.statusNotes", { count: titleCount, space, names });
  else if (body !== null && body.more) status = `${space} · ${names} · ${plainStatus}`;
  else status = t("tagSearch.statusResults", { count: body === null ? titleCount : body.count, space, names });
  return (
    <>
      <p role="status" className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {status}
      </p>
      {addable.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-4 pb-1.5">
          <span className="text-[11px] text-muted-foreground">{t("tagSearch.addMore")}</span>
          {addable.map((tag) => (
            <button
              key={tag.id}
              type="button"
              onClick={() => onTagTokensChange?.(addToken(tagTokens, tokenFromTag(tag, first.space)))}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs hover:bg-brand-soft hover:text-brand-on-soft pointer-coarse:py-1.5"
            >
              <TagDot color={tag.color} />
              <span className="truncate">{tag.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
