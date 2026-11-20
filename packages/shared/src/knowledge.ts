import type { KnowledgePropName } from "./knowledge-schema.js";

export const KNOWLEDGE_EVIDENCE = ["tested", "docs", "inferred"] as const;
/** "" = unconfirmed */
export type KnowledgeEvidence = "" | (typeof KNOWLEDGE_EVIDENCE)[number];
export const KNOWLEDGE_STATUSES = ["unverified", "outdated"] as const;
/** "" = current, "unverified" = needs review */
export type KnowledgeStatus = "" | (typeof KNOWLEDGE_STATUSES)[number];

export interface KnowledgeInfo {
  id: string;
  when: string;
  conclusion: string;
  evidence: KnowledgeEvidence;
  verified: string;
  status: KnowledgeStatus;
  supersededBy: string;
}
export type KnowledgeDraft = Omit<KnowledgeInfo, "id">;

export const KNOWLEDGE_WHEN_MAX = 200;
export const KNOWLEDGE_CONCLUSION_MAX = 300;
export const KNOWLEDGE_ID_RE = /^k_[0-9a-f]{8}$/;

const NOTE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Collab state is untrusted: an attribute may be an array, number or object.
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function readKnowledgeInfo(props: Readonly<Record<string, unknown>> | undefined): KnowledgeInfo | null {
  if (!props) return null;
  const id = str(props.knowledgeId);
  if (id === "") return null;
  const evidence = str(props.knowledgeEvidence);
  const status = str(props.knowledgeStatus);
  return {
    id,
    when: str(props.knowledgeWhen),
    conclusion: str(props.knowledgeConclusion),
    evidence: (KNOWLEDGE_EVIDENCE as readonly string[]).includes(evidence) ? (evidence as KnowledgeEvidence) : "",
    verified: str(props.knowledgeVerified),
    status: (KNOWLEDGE_STATUSES as readonly string[]).includes(status) ? (status as KnowledgeStatus) : "",
    supersededBy: str(props.knowledgeSupersededBy),
  };
}

export function knowledgeInfoToProps(info: KnowledgeInfo): Record<KnowledgePropName, string> {
  return {
    knowledgeId: info.id,
    knowledgeWhen: info.when,
    knowledgeConclusion: info.conclusion,
    knowledgeEvidence: info.evidence,
    knowledgeVerified: info.verified,
    knowledgeStatus: info.status,
    knowledgeSupersededBy: info.supersededBy,
  };
}

export function knowledgePropsPatch(before: KnowledgeInfo | null, after: KnowledgeInfo): Partial<Record<KnowledgePropName, string>> {
  const next = knowledgeInfoToProps(after);
  const prev = before ? knowledgeInfoToProps(before) : null;
  const patch: Partial<Record<KnowledgePropName, string>> = {};
  for (const name of Object.keys(next) as KnowledgePropName[]) {
    if (prev ? next[name] !== prev[name] : next[name] !== "" || name === "knowledgeId") patch[name] = next[name];
  }
  return patch;
}

export function knowledgeTextLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    // A high surrogate followed by its low surrogate is one code point.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

export function normalizeKnowledgeText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ").trim();
}

export function isKnowledgeDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  // setUTCFullYear: Date.UTC maps years 0-99 to 1900-1999.
  date.setUTCFullYear(y);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export interface KnowledgeRef {
  noteId: string | null;
  knowledgeId: string;
}

export function parseKnowledgeRef(value: string): KnowledgeRef | null {
  const hash = value.indexOf("#");
  if (hash === -1) return KNOWLEDGE_ID_RE.test(value) ? { noteId: null, knowledgeId: value } : null;
  const noteId = value.slice(0, hash);
  const knowledgeId = value.slice(hash + 1);
  if (!NOTE_ID_RE.test(noteId) || !KNOWLEDGE_ID_RE.test(knowledgeId)) return null;
  return { noteId: noteId.toLowerCase(), knowledgeId };
}

export function formatKnowledgeRef(ref: KnowledgeRef, currentNoteId: string | null): string {
  if (ref.noteId === null || (currentNoteId !== null && ref.noteId.toLowerCase() === currentNoteId.toLowerCase())) return ref.knowledgeId;
  return `${ref.noteId.toLowerCase()}#${ref.knowledgeId}`;
}

export type KnowledgeDraftError = "empty" | "whenTooLong" | "conclusionTooLong" | "verifiedInvalid" | "supersededRequired" | "supersededInvalid" | "supersededSelf";

export function validateKnowledgeDraft(
  draft: KnowledgeDraft,
  self: KnowledgeRef | null,
  currentNoteId: string | null,
  touched?: ReadonlySet<keyof KnowledgeDraft>,
): KnowledgeDraftError | null {
  const checks = (field: keyof KnowledgeDraft): boolean => !touched || touched.has(field);
  if (
    draft.when.trim() === "" && draft.conclusion.trim() === "" && draft.evidence === "" &&
    draft.verified === "" && draft.status === "" && draft.supersededBy === ""
  ) return "empty";
  if (draft.status === "outdated" && draft.supersededBy.trim() === "") return "supersededRequired";
  const target = draft.status === "outdated" ? parseKnowledgeRef(draft.supersededBy.trim()) : null;
  if (draft.status === "outdated" && !target) return "supersededInvalid";
  if (target && self) {
    const own = (n: string | null): string | null => (n === null ? currentNoteId : n.toLowerCase());
    if (target.knowledgeId === self.knowledgeId && own(target.noteId) === own(self.noteId)) return "supersededSelf";
  }
  if (checks("when") && knowledgeTextLength(draft.when) > KNOWLEDGE_WHEN_MAX) return "whenTooLong";
  if (checks("conclusion") && knowledgeTextLength(draft.conclusion) > KNOWLEDGE_CONCLUSION_MAX) return "conclusionTooLong";
  if (checks("verified") && draft.verified !== "" && !isKnowledgeDate(draft.verified)) return "verifiedInvalid";
  return null;
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

function randomUint32(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c && typeof c.getRandomValues === "function") return c.getRandomValues(new Uint32Array(1))[0]!;
  return Math.floor(Math.random() * 0x100000000);
}

export function generateKnowledgeId(taken: ReadonlySet<string>): string {
  let n = randomUint32();
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = `k_${hex8(n)}`;
    if (!taken.has(id)) return id;
    n = randomUint32();
  }
  // Only reachable with a broken random source or a nearly exhausted id space.
  for (;;) {
    n = (n + 1) >>> 0;
    const id = `k_${hex8(n)}`;
    if (!taken.has(id)) return id;
  }
}

function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Pure function of its inputs: every editor (and the server) renewing the same duplicate must land on the same id.
export function renewKnowledgeId(blockId: string, oldId: string, taken: ReadonlySet<string>): string {
  for (let n = 0; ; n += 1) {
    const id = `k_${hex8(fnv1a32(`${blockId}\u0000${oldId}\u0000${n}`))}`;
    if (!taken.has(id)) return id;
  }
}

export function knowledgeIdRenewals(
  items: readonly { blockId: string; knowledgeId: string; inserted?: boolean }[],
): Array<{ blockId: string; knowledgeId: string }> {
  const groups = new Map<string, number[]>();
  const taken = new Set<string>();
  items.forEach((item, i) => {
    if (item.knowledgeId === "") return;
    taken.add(item.knowledgeId);
    const group = groups.get(item.knowledgeId);
    if (group) group.push(i);
    else groups.set(item.knowledgeId, [i]);
  });
  const renew = new Set<number>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const settled = members.filter((i) => !items[i]!.inserted);
    const keeper = settled.length > 0 && settled.length < members.length ? settled[0]! : members[0]!;
    for (const i of members) if (i !== keeper) renew.add(i);
  }
  const out: Array<{ blockId: string; knowledgeId: string }> = [];
  items.forEach((item, i) => {
    if (!renew.has(i)) return;
    const id = renewKnowledgeId(item.blockId, item.knowledgeId, taken);
    taken.add(id);
    out.push({ blockId: item.blockId, knowledgeId: id });
  });
  return out;
}
