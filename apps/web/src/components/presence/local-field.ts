import { useEffect } from "react";
import type { Awareness } from "y-protocols/awareness";
import { PRESENCE_FIELD, type AvatarRef, type Role, type UserPresenceField } from "@knotebook/shared";

/**
 * #293：本分頁在這條連線的 awareness 寫 `knotebook` 欄（BlockNote 擁有 `user`，這裡不碰）。
 *
 * 另訂 provider 的兩個事件，補 y-protocols／Hocuspocus 重連時的兩個洞（y-protocols `applyAwarenessUpdate`
 * 只收 `currClock < clock` 的狀態）：
 * - `authenticated`（每次連上都發）：provider `onOpen` 重送的本機狀態沿用舊 clock；server 在舊連線關閉時
 *   已 `removeAwarenessStates`（@hocuspocus/server `Document.removeConnection`）但 clock 沒加，同 clock 的重送被忽略、
 *   要等 15 s renew。這裡同值重寫一次（clock＋1），server 收為 `updated`，此人立即回到別人的頭像列（有測試釘住）。
 * - `close`：provider `onClose` 只刪遠端 state、不刪 meta clock（@hocuspocus/provider 4.5.0 `HocuspocusProvider.onClose`；
 *   它的 listener 先於 `close` 事件轉發註冊，收到時 state 已刪），重連後 server 以同 clock 送來的現況被本機忽略。
 *   這裡刪掉本機以外、已沒有 state 的遠端 meta，讓現況被當成 `added` 收下（有測試與其對照案）。
 *
 * 值 effect 以「本機現有的欄位值」去重：重連時 role 會走 owner→null→owner、StrictMode 會掛兩次，deps 回到原值時不重寫。
 *
 * 只寫 awareness，不碰 connect／disconnect 與 useCollab 的重啟排程。
 */

type ConnectionEvent = "authenticated" | "close";

export type PresenceProvider = {
  awareness?: Awareness | null;
  on?(event: ConnectionEvent, fn: () => void): unknown;
  off?(event: ConnectionEvent, fn: () => void): unknown;
};

/** 模組層：上次寫出的 name／avatar 與其 since（N-d：同一分頁換篇、NotePage 重掛都沿用）。 */
let lastIdentity: { name: string; avatarId: string | null; avatarV: number | null; since: number } | null = null;

function sinceFor(name: string, avatarId: string | null, avatarV: number | null): number {
  if (lastIdentity && lastIdentity.name === name && lastIdentity.avatarId === avatarId && lastIdentity.avatarV === avatarV) {
    return lastIdentity.since;
  }
  lastIdentity = { name, avatarId, avatarV, since: Date.now() };
  return lastIdentity.since;
}

export function resetLocalPresenceFieldForTest(): void {
  lastIdentity = null;
}

/** role 為 null／"none" 不寫（保留上一次的值）；值未變不寫。 */
export function useLocalPresenceField(input: {
  provider: PresenceProvider | null;
  role: Role | null;
  name: string | null;
  avatar: AvatarRef | null;
}): void {
  const { provider, role, name, avatar } = input;
  const awareness = provider?.awareness ?? null;
  const avatarId = avatar?.id ?? null;
  const avatarV = avatar?.v ?? null;

  useEffect(() => {
    if (awareness === null || name === null || role === null || role === "none") return;
    const value: UserPresenceField = {
      v: 1,
      kind: "user",
      role,
      avatar: avatarId !== null && avatarV !== null ? { id: avatarId, v: avatarV } : null,
      since: sinceFor(name, avatarId, avatarV),
    };
    const current: unknown = awareness.getLocalState()?.[PRESENCE_FIELD];
    if (JSON.stringify(current) === JSON.stringify(value)) return;
    awareness.setLocalStateField(PRESENCE_FIELD, value);
  }, [awareness, role, name, avatarId, avatarV]);

  useEffect(() => {
    if (!provider?.on || awareness === null) return;
    const onAuthenticated = () => {
      const current: unknown = awareness.getLocalState()?.[PRESENCE_FIELD];
      // 同值、clock＋1：重連後 server 才會接受
      if (current !== undefined) awareness.setLocalStateField(PRESENCE_FIELD, current);
    };
    const onClose = () => {
      // 重連後才收得下同 clock 的現況
      for (const id of [...awareness.meta.keys()]) {
        if (id !== awareness.clientID && !awareness.states.has(id)) awareness.meta.delete(id);
      }
    };
    provider.on("authenticated", onAuthenticated);
    provider.on("close", onClose);
    return () => {
      provider.off?.("authenticated", onAuthenticated);
      provider.off?.("close", onClose);
    };
  }, [provider, awareness]);
}
