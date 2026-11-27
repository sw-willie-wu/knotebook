import type { ReactNode } from "react";
import type { CommentMentionDto } from "@knotebook/shared";

export type BodySegment = { kind: "text"; text: string } | { kind: "mention"; text: string; mention: CommentMentionDto };

/**
 * Only the stored spans become chips: the body is never scanned for `@`, so typed text can't pass for a mention. Offsets are code points;
 * a span that overlaps an earlier one or runs past the body is left as text.
 */
export function splitBody(body: string, mentions: readonly CommentMentionDto[]): BodySegment[] {
  const cps = Array.from(body);
  const out: BodySegment[] = [];
  let at = 0;
  for (const m of [...mentions].sort((a, b) => a.start - b.start)) {
    if (m.length <= 0 || m.start < at || m.start + m.length > cps.length) continue;
    if (m.start > at) out.push({ kind: "text", text: cps.slice(at, m.start).join("") });
    out.push({ kind: "mention", text: cps.slice(m.start, m.start + m.length).join(""), mention: m });
    at = m.start + m.length;
  }
  if (at < cps.length) out.push({ kind: "text", text: cps.slice(at).join("") });
  return out;
}

/** Light = `AGENT_PRESENCE_COLOR`, dark brighter for contrast, as `Avatar`'s agent icon. */
const AGENT_CHIP = "bg-[#7c3aed]/10 text-[#7c3aed] dark:text-[#a78bfa]";

export function MentionChip({ mention }: { mention: CommentMentionDto }) {
  const name = mention.displayName || mention.handle;
  const agent = mention.agentLabel !== null;
  return (
    <span
      data-testid="mention-chip"
      data-user-id={mention.userId}
      title={agent ? `@${mention.handle}/${mention.agentLabel}` : `@${mention.handle}`}
      className={agent ? `rounded px-0.5 font-medium ${AGENT_CHIP}` : "rounded bg-brand-soft px-0.5 font-medium text-brand-on-soft"}
    >
      {agent ? `@${mention.handle} (${mention.agentLabel})` : `@${name}`}
    </span>
  );
}

export function CommentBody({ body, mentions }: { body: string; mentions: readonly CommentMentionDto[] }) {
  const parts: ReactNode[] = splitBody(body, mentions).map((seg, i) =>
    seg.kind === "text" ? seg.text : <MentionChip key={i} mention={seg.mention} />,
  );
  return <p className="whitespace-pre-wrap break-words text-sm">{parts}</p>;
}
