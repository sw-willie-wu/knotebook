import {
  AGENT_PRESENCE_COLOR,
  PRESENCE_FIELD,
  collabUserColor,
  parseAvatarRef,
  type AvatarRef,
  type PresenceRole,
} from "@knotebook/shared";

/**
 * #293：頁頭頭像列的名單（純函式，不碰 React）。awareness 是 client 自報，
 * 這裡每一格都當不可信：`knotebook` 欄只收 `v === 1`、角色只收白名單、頭貼一律過 `parseAvatarRef`、
 * 顏色一律自己算（不讀 `state.user.color`）。
 */

export type PresenceKey = `user:${string}` | `agent:${number}`;

interface Common {
  key: PresenceKey;
  color: string;
  hasCursor: boolean;
}

export interface UserPresencePerson extends Common {
  kind: "user";
  userId: string;
  name: string;
  role: PresenceRole | null;
  avatar: AvatarRef | null;
}

export interface AgentPresencePerson extends Common {
  kind: "agent";
  clientId: number;
  handle: string;
  label: string;
}

export type PresencePerson = UserPresencePerson | AgentPresencePerson;

const ROLE_RANK: Record<PresenceRole, number> = { viewer: 1, editor: 2, owner: 3 };

type Entry =
  | { kind: "agent"; clientId: number; handle: string; label: string; cursor: unknown }
  | {
      kind: "user";
      clientId: number;
      userId: string;
      name: string;
      role: PresenceRole | null;
      avatar: AvatarRef | null;
      since: number;
      cursor: unknown;
    };

type UserEntry = Extract<Entry, { kind: "user" }>;

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x !== "";
}

function parseRole(x: unknown): PresenceRole | null {
  return x === "owner" || x === "editor" || x === "viewer" ? x : null;
}

/** owner > editor > viewer > null。 */
function higherRole(a: PresenceRole | null, b: PresenceRole | null): PresenceRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/** 單一 awareness 狀態 → 一筆；該略過的回 null（1–3）。 */
function parseEntry(clientId: number, state: unknown, myClientId: number, myUserId: string): Entry | null {
  if (clientId === myClientId) return null;
  if (typeof state !== "object" || state === null) return null;
  const s = state as { user?: unknown; cursor?: unknown; [PRESENCE_FIELD]?: unknown };
  const raw = s[PRESENCE_FIELD];
  const field =
    typeof raw === "object" && raw !== null && (raw as { v?: unknown }).v === 1
      ? (raw as { kind?: unknown; role?: unknown; avatar?: unknown; since?: unknown; handle?: unknown; label?: unknown })
      : null;
  const cursor = s.cursor ?? null;
  if (field?.kind === "agent") {
    // server 一定帶 handle 與 label；缺了就是偽造或壞資料，整筆略過。
    if (!isNonEmptyString(field.handle) || !isNonEmptyString(field.label)) return null;
    return { kind: "agent", clientId, handle: field.handle, label: field.label, cursor };
  }
  const user = s.user;
  if (typeof user !== "object" || user === null) return null;
  const { id, name } = user as { id?: unknown; name?: unknown };
  if (!isNonEmptyString(id) || id === myUserId) return null;
  const isUserField = field?.kind === "user";
  const since = isUserField && typeof field.since === "number" && Number.isFinite(field.since) ? field.since : -Infinity;
  return {
    kind: "user",
    clientId,
    userId: id,
    name: typeof name === "string" ? name : "",
    role: isUserField ? parseRole(field.role) : null,
    avatar: isUserField ? parseAvatarRef(field.avatar) : null,
    since,
    cursor,
  };
}

function entryKey(e: Entry): PresenceKey {
  return e.kind === "agent" ? `agent:${e.clientId}` : `user:${e.userId}`;
}

/** since 大者勝；同分取 clientID 大者（只求穩定）。 */
function newer(a: UserEntry, b: UserEntry): UserEntry {
  if (a.since !== b.since) return a.since > b.since ? a : b;
  return a.clientId > b.clientId ? a : b;
}

function entries(states: ReadonlyMap<number, unknown>, myClientId: number, myUserId: string): Entry[] {
  const out: Entry[] = [];
  for (const [clientId, state] of states) {
    const e = parseEntry(clientId, state, myClientId, myUserId);
    if (e) out.push(e);
  }
  return out;
}

/** 1–4：略過自己的 clientID、`state` 非物件、`user.id === myUserId`、既無字串 `user.id` 也無 agent 標記者；AI 以 clientID 為一項；人以 user id 合併。回傳依 key 字典序（排序由 orderBySeen 負責）。 */
export function presencePeople(states: ReadonlyMap<number, unknown>, myClientId: number, myUserId: string): PresencePerson[] {
  const people = new Map<PresenceKey, PresencePerson>();
  const latest = new Map<PresenceKey, UserEntry>();
  for (const e of entries(states, myClientId, myUserId)) {
    const key = entryKey(e);
    const hasCursor = e.cursor != null;
    if (e.kind === "agent") {
      people.set(key, { kind: "agent", key, clientId: e.clientId, handle: e.handle, label: e.label, color: AGENT_PRESENCE_COLOR, hasCursor });
      continue;
    }
    const prev = people.get(key) as UserPresencePerson | undefined;
    const prevLatest = latest.get(key);
    const best = prevLatest ? newer(prevLatest, e) : e;
    latest.set(key, best);
    const role = prev ? higherRole(prev.role, e.role) : e.role;
    people.set(key, {
      kind: "user",
      key,
      userId: e.userId,
      name: best.name,
      role,
      avatar: best.avatar,
      color: collabUserColor(e.userId),
      hasCursor: hasCursor || (prev?.hasCursor ?? false),
    });
  }
  return [...people.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 該 key 目前「有 cursor 且 since 最大」那份狀態的 cursor（同分取 clientID 大者）；沒有 → null。點擊當下呼叫，讀即時狀態。 */
export function presenceCursor(
  states: ReadonlyMap<number, unknown>,
  key: PresenceKey,
  myClientId: number,
  myUserId: string,
): unknown | null {
  let best: Entry | null = null;
  for (const e of entries(states, myClientId, myUserId)) {
    if (e.cursor == null || entryKey(e) !== key) continue;
    // AI 的 key 帶 clientID，只會有一份；人才需要挑 since 最大者。
    best = best !== null && best.kind === "user" && e.kind === "user" ? newer(best, e) : e;
  }
  return best?.cursor ?? null;
}

/** 先來的在左；離開即移除；再回來排最後。 */
export function orderBySeen(
  seen: ReadonlyMap<PresenceKey, number>,
  people: readonly PresencePerson[],
  nextSeq: number,
): { seen: Map<PresenceKey, number>; people: PresencePerson[]; nextSeq: number } {
  const next = new Map<PresenceKey, number>();
  let seq = nextSeq;
  for (const p of people) {
    const s = seen.get(p.key);
    if (s === undefined) {
      next.set(p.key, seq);
      seq += 1;
    } else {
      next.set(p.key, s);
    }
  }
  const ordered = [...people].sort((a, b) => next.get(a.key)! - next.get(b.key)!);
  return { seen: next, people: ordered, nextSeq: seq };
}

/** 鍵、名字、角色、頭貼 id／v、有沒有游標（布林）。游標位置不在內。 */
export function presenceSignature(people: readonly PresencePerson[]): string {
  return JSON.stringify(
    people.map((p) =>
      p.kind === "agent"
        ? [p.key, p.handle, p.label, p.hasCursor]
        : [p.key, p.name, p.role, p.avatar?.id ?? null, p.avatar?.v ?? null, p.hasCursor],
    ),
  );
}

export const PRESENCE_CAPACITY = { wide: 5, narrow: 2 } as const;

function fit(total: number, capacity: number): { shown: number; more: number } {
  if (total > capacity) {
    const shown = capacity - 1;
    return { shown, more: total - shown };
  }
  return { shown: total, more: 0 };
}

/** 超過容量時 shown＝容量−1、more＝total−shown；未超過時 shown＝total、more＝0。 */
export function presenceLayout(total: number): {
  wide: { shown: number; more: number };
  narrow: { shown: number; more: number };
} {
  return { wide: fit(total, PRESENCE_CAPACITY.wide), narrow: fit(total, PRESENCE_CAPACITY.narrow) };
}

export { firstGrapheme, hasVisibleText } from "@/lib/first-grapheme";
