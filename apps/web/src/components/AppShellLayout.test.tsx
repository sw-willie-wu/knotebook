import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useContext, useMemo, useRef, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { BlockAnchorContext, type BlockAnchorApi } from "@/hooks/block-anchor-context";
import { useNotePageControls, type NotePageControls } from "@/lib/note-page-controls";
import { useRegisterNotePage } from "@/lib/note-page-bridge";
import { useAppShellInert } from "@/lib/app-shell-inert";
import { AppShellLayout } from "./AppShellLayout";

// 殼本身不在這裡測：換成只渲染 children 的替身，專看 layout 提供給側欄的 context 與 inert。
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children, inert }: { children: ReactNode; inert?: boolean }) => (
    <div data-testid="shell" data-inert={String(inert === true)}>
      {children}
    </div>
  ),
}));

/** 側欄那一側：只讀 layout 提供的 context。 */
function SidebarProbe() {
  const controls = useNotePageControls();
  const anchors = useContext(BlockAnchorContext);
  return <p data-testid="probe">{`${controls?.noteId ?? "none"}|${anchors.currentNoteId ?? "none"}`}</p>;
}

function Page() {
  const leavingRef = useRef(false);
  const controls = useMemo<NotePageControls>(
    () => ({ noteId: "note-1", state: { phase: "connecting" } as NotePageControls["state"], leavingRef, openEdits: () => {} }),
    [],
  );
  const anchors = useMemo<BlockAnchorApi>(() => ({ currentNoteId: "note-1", requestAnchor: () => {}, scrollToTop: () => {} }), []);
  useRegisterNotePage(controls, anchors);
  useAppShellInert(true);
  return <p>page</p>;
}

function GoHome() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate("/")}>
      go-home
    </button>
  );
}

describe("AppShellLayout", () => {
  it("頁面登記的控制、錨點 API 與 inert 到得了殼底下的消費者（側欄）；頁面卸載就清掉", async () => {
    render(
      <MemoryRouter initialEntries={["/n"]}>
        <Routes>
          <Route element={<AppShellLayout />}>
            <Route
              path="/n"
              element={
                <>
                  <Page />
                  <SidebarProbe />
                </>
              }
            />
            <Route path="/" element={<SidebarProbe />} />
          </Route>
        </Routes>
        <GoHome />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("note-1|note-1");
    expect(screen.getByTestId("shell")).toHaveAttribute("data-inert", "true");

    fireEvent.click(screen.getByRole("button", { name: "go-home" }));
    expect(await screen.findByText("none|none")).toBeInTheDocument();
    expect(screen.getByTestId("shell")).toHaveAttribute("data-inert", "false");
  });
});
