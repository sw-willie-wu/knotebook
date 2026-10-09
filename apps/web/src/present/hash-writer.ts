import type { Location, NavigateOptions, To } from "react-router";
import { hashForSlide } from "./present-url";

/**
 * #229 投影片 hash 寫入（spec §6.4-5）：`navigate({ pathname: latest.pathname, search: latest.search, hash }, { replace, state: latest.state })`。
 * `latest` 取自每次 render 更新的 ref（不是 effect 閉包裡的 location——否則改名收斂後會把舊 pathname 寫回）；
 * history 當下的 key 與 render 到的 key 不同＝導覽在途，延到下一次 render（flush）再寫——同 NotePage 收斂 effect 的守衛。
 * 只改 hash：收斂 effect 與 AppShell 抽屜 effect 都看 pathname，會早退。
 */
export interface HashWriterDeps {
  latest: () => Location;
  currentKey: () => string;
  historyKey: () => string | undefined;
  navigate: (to: To, options: NavigateOptions) => void;
}

export interface HashWriter {
  request(id: string): void;
  flush(): void;
}

export function createHashWriter(deps: HashWriterDeps): HashWriter {
  let pending: string | null = null;

  const tryWrite = () => {
    if (pending === null) return;
    const latest = deps.latest();
    const hash = hashForSlide(pending);
    if (latest.hash === hash) {
      pending = null;
      return;
    }
    const historyKey = deps.historyKey();
    if (historyKey !== undefined && historyKey !== deps.currentKey()) return;
    pending = null;
    deps.navigate({ pathname: latest.pathname, search: latest.search, hash }, { replace: true, state: latest.state });
  };

  return {
    request(id) {
      pending = id;
      tryWrite();
    },
    flush: tryWrite,
  };
}
