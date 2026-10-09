import { describe, expect, it, vi } from "vitest";
import type { Location } from "react-router";
import { createHashWriter } from "./hash-writer";

function location(pathname: string, hash = "", key = "k1", state: unknown = null): Location {
  return { pathname, search: "?present", hash, key, state };
}

describe("createHashWriter（spec §6.4-5）", () => {
  it("以最新 location 寫 #/<id>：replace、保留 search 與 state", () => {
    const navigate = vi.fn();
    const latest = location("/n/a/b", "", "k1", { knotebookPresentPushed: true });
    const writer = createHashWriter({ latest: () => latest, currentKey: () => "k1", historyKey: () => "k1", navigate });
    writer.request("h2");
    expect(navigate).toHaveBeenCalledWith(
      { pathname: "/n/a/b", search: "?present", hash: "#/h2" },
      { replace: true, state: { knotebookPresentPushed: true } },
    );
  });

  it("hash 已是目標 → 不寫", () => {
    const navigate = vi.fn();
    const writer = createHashWriter({ latest: () => location("/n/a/b", "#/h2"), currentKey: () => "k1", historyKey: () => "k1", navigate });
    writer.request("h2");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("導覽在途（history key ≠ render 到的 key）→ 延後；flush 時用那時的最新 pathname（不把舊 pathname 寫回）", () => {
    const navigate = vi.fn();
    let latest = location("/notes/uuid", "#/x", "k1");
    let historyKey = "k2"; // 收斂已 replace、router 還沒跟上
    const writer = createHashWriter({ latest: () => latest, currentKey: () => latest.key, historyKey: () => historyKey, navigate });
    writer.request("h2");
    expect(navigate).not.toHaveBeenCalled();
    latest = location("/n/tester/my-note", "#/x", "k2");
    historyKey = "k2";
    writer.flush();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toEqual({ pathname: "/n/tester/my-note", search: "?present", hash: "#/h2" });
  });

  it("historyKey 讀不到（undefined）→ 照常寫", () => {
    const navigate = vi.fn();
    const writer = createHashWriter({ latest: () => location("/n/a/b"), currentKey: () => "k1", historyKey: () => undefined, navigate });
    writer.request("h2");
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("沒有待寫的 id 時 flush 不做事", () => {
    const navigate = vi.fn();
    createHashWriter({ latest: () => location("/n/a/b"), currentKey: () => "k1", historyKey: () => "k1", navigate }).flush();
    expect(navigate).not.toHaveBeenCalled();
  });
});
