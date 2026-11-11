import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsGroup } from "./SettingsLayout";

// SettingsGroup 的 `labelledByTitle`（#181）：開了才以標題命名成 region；預設不是 landmark。

describe("SettingsGroup labelledByTitle", () => {
  it("SL-T1a 帶 labelledByTitle＋title → region 以標題命名，aria-labelledby 指向那個 h2", () => {
    render(
      <SettingsGroup labelledByTitle title="A">
        <p>body</p>
      </SettingsGroup>,
    );
    const region = screen.getByRole("region", { name: "A" });
    const heading = screen.getByRole("heading", { level: 2, name: "A" });
    const id = region.getAttribute("aria-labelledby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")).toBe(heading);
  });

  it("SL-T1b 同時兩個 → 兩個 region，id 不撞", () => {
    render(
      <>
        <SettingsGroup labelledByTitle title="A" />
        <SettingsGroup labelledByTitle title="B" />
      </>,
    );
    const a = screen.getByRole("region", { name: "A" });
    const b = screen.getByRole("region", { name: "B" });
    expect(screen.getAllByRole("region")).toHaveLength(2);
    expect(a.getAttribute("aria-labelledby")).not.toBe(b.getAttribute("aria-labelledby"));
  });

  it("SL-T1c 不帶 labelledByTitle → 不是 region、沒有 aria-labelledby、h2 沒有 id", () => {
    const { container } = render(<SettingsGroup title="A" description="d" />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("section")).not.toHaveAttribute("aria-labelledby");
    expect(screen.getByRole("heading", { level: 2, name: "A" })).not.toHaveAttribute("id");
  });

  it("SL-T1d 帶了 labelledByTitle 但沒有 title → 沒有 aria-labelledby、不是 region", () => {
    const { container } = render(
      <SettingsGroup labelledByTitle description="only description">
        <p>body</p>
      </SettingsGroup>,
    );
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("section")).not.toHaveAttribute("aria-labelledby");
  });
});
