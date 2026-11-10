import { useCallback, useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import {
  orderBySeen,
  presenceCursor,
  presencePeople,
  presenceSignature,
  type PresenceKey,
  type PresencePerson,
} from "./people";

/**
 * #293：訂閱 awareness 的 `change`（y-protocols 只在狀態內容不同時發；心跳只發 update），
 * 一幀內多次合併成一次重算；簽章（鍵、名字、角色、頭貼、有無游標）沒變就不 setState——游標移動不重繪頭像列，
 * 點擊時由 `cursorOf` 讀即時狀態。
 */

const EMPTY: PresencePerson[] = [];

interface Track {
  awareness: Awareness | null;
  userId: string | null;
  seen: Map<PresenceKey, number>;
  nextSeq: number;
  signature: string;
}

function compute(awareness: Awareness | null, userId: string | null, seen: ReadonlyMap<PresenceKey, number>, nextSeq: number) {
  const listed = awareness === null || userId === null ? EMPTY : presencePeople(awareness.getStates(), awareness.clientID, userId);
  const ordered = orderBySeen(seen, listed, nextSeq);
  return { ...ordered, signature: presenceSignature(ordered.people) };
}

export function usePresencePeople(
  awareness: Awareness | null,
  myUserId: string | null,
): { people: PresencePerson[]; cursorOf: (key: PresenceKey) => unknown | null } {
  // 首屏直接算（不等幀）；seen／nextSeq 由同一次計算帶進 ref。
  const [initial] = useState(() => compute(awareness, myUserId, new Map(), 0));
  const trackRef = useRef<Track>({
    awareness,
    userId: myUserId,
    seen: initial.seen,
    nextSeq: initial.nextSeq,
    signature: initial.signature,
  });
  const [people, setPeople] = useState<PresencePerson[]>(initial.people);

  useEffect(() => {
    const track = trackRef.current;
    if (track.awareness !== awareness || track.userId !== myUserId) {
      // 換篇（新 awareness）或換人：順序重新起算。
      track.awareness = awareness;
      track.userId = myUserId;
      track.seen = new Map();
      track.nextSeq = 0;
      track.signature = "";
    }
    let pending: number | null = null;
    const flush = () => {
      pending = null;
      const next = compute(awareness, myUserId, track.seen, track.nextSeq);
      track.seen = next.seen;
      track.nextSeq = next.nextSeq;
      if (next.signature === track.signature) return;
      track.signature = next.signature;
      setPeople(next.people);
    };
    // render 到 effect 之間可能已有變更：同步補算一次（簽章沒變就不 setState）。
    flush();
    if (awareness === null || myUserId === null) return;
    const onChange = () => {
      if (pending === null) pending = requestAnimationFrame(flush);
    };
    awareness.on("change", onChange);
    return () => {
      awareness.off("change", onChange);
      if (pending !== null) cancelAnimationFrame(pending);
    };
  }, [awareness, myUserId]);

  const cursorOf = useCallback(
    (key: PresenceKey) =>
      awareness === null || myUserId === null
        ? null
        : presenceCursor(awareness.getStates(), key, awareness.clientID, myUserId),
    [awareness, myUserId],
  );

  return { people: awareness === null || myUserId === null ? EMPTY : people, cursorOf };
}
