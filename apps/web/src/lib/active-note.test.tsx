import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActiveNoteProvider, useActiveNote } from "./active-note";

function Probe() {
  const { activeNoteId } = useActiveNote();
  return <div data-testid="probe">{activeNoteId ?? "none"}</div>;
}

/** 復刻 NotePage 的接線形（set-after-load＋卸載條件清除）——這裡釘的是 context 的
 * 清除語意本身，NotePage 端的實際 set 行為在 NotePage.test。 */
function Page({ id }: { id: string }) {
  const { setActiveNoteId, clearActiveNoteId } = useActiveNote();
  useEffect(() => {
    setActiveNoteId(id);
    return () => clearActiveNoteId(id);
  }, [id, setActiveNoteId, clearActiveNoteId]);
  return null;
}

describe("ActiveNoteContext", () => {
  it("換頁：舊頁 cleanup 先跑（同 key 換 id）→ 新 id 接手，關頁（整個卸載）→ 清空", () => {
    const view = render(
      <ActiveNoteProvider>
        <Probe />
        <Page id="aaa" />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("aaa");

    view.rerender(
      <ActiveNoteProvider>
        <Probe />
        <Page id="bbb" />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("bbb");

    view.rerender(
      <ActiveNoteProvider>
        <Probe />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("none");
  });

  it("條件清除防換頁競態：新頁 set 之後才卸載的舊頁**不得**把高亮滅掉", () => {
    // 先 A 後 B 並存（B 的 set 較晚跑 → active=B），再移除 A——A 的 cleanup 此時
    // current 已是 B，無條件清除會把剛亮起來的 B 滅掉（clearActiveNoteId 的存在理由）。
    const view = render(
      <ActiveNoteProvider>
        <Probe />
        <Page key="a" id="aaa" />
        <Page key="b" id="bbb" />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("bbb");

    view.rerender(
      <ActiveNoteProvider>
        <Probe />
        <Page key="b" id="bbb" />
      </ActiveNoteProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("bbb");
  });

  it("provider 外使用 → fail-loud（接線錯誤不得靜默退化成永遠沒高亮）", () => {
    expect(() => render(<Probe />)).toThrow(/ActiveNoteProvider/);
  });
});
