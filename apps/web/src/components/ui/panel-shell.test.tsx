import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, MENU_CONTENT_BASE } from "./dropdown-menu";
import { PANEL_PLACEMENT, PANEL_SURFACE } from "./panel-shell";
import { SidebarPanel } from "./sidebar-panel";

afterEach(cleanup);

describe("sidebar panel shell", () => {
  it("the dropdown menu and the popover panel render the same surface and placement", () => {
    expect(MENU_CONTENT_BASE).toBe(PANEL_SURFACE);
    const trigger = { current: document.body };
    render(
      <>
        <DropdownMenu open>
          <DropdownMenuTrigger>t</DropdownMenuTrigger>
          <DropdownMenuContent {...PANEL_PLACEMENT} data-testid="menu">
            <div>x</div>
          </DropdownMenuContent>
        </DropdownMenu>
        <SidebarPanel triggerRef={trigger} onClose={() => {}} aria-label="p" data-testid="panel">
          <div>y</div>
        </SidebarPanel>
      </>,
    );
    for (const token of PANEL_SURFACE.split(" ")) {
      expect(screen.getByTestId("menu")).toHaveClass(token);
      expect(screen.getByTestId("panel")).toHaveClass(token);
    }
    expect(screen.getByTestId("menu").getAttribute("data-align")).toBe(PANEL_PLACEMENT.align);
    expect(screen.getByTestId("panel").getAttribute("data-align")).toBe(PANEL_PLACEMENT.align);
  });
});
