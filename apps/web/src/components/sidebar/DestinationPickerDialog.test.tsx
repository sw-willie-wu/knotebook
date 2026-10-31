import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FolderDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ApiFail } from "@/api/client";
import { folderDto } from "@/test/folder-fixtures";
import { buildDestinationLevel, type DestItem, type DestPathStep, type DestSource, type DestSpace } from "./destination-level";
import { DestinationPickerDialog } from "./DestinationPickerDialog";
import { EMPTY_FOLDER_INDEX, indexFolders } from "./folder-index";

// 目的地選擇框（#181 PR-2c T5 的 DP1–DP5；PR-3b-2 T6a 改成一次一層：DPf1–DPf5）。
// 層內容一律由 T2 的 `buildDestinationLevel` 產生（與 SelectActionBar 同一支）。

type Props = Parameters<typeof DestinationPickerDialog>[0];

const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

const PERSONAL: DestSpace = { kind: "personal" };
const TEAM: DestSpace = { kind: "group", groupId: "ga", name: "Team" };
/** 個人資料夾：A ⊃ A1、B。 */
const FA = folderDto({ id: "A", name: "A" });
const FA1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
const FB = folderDto({ id: "B", name: "B" });
const INDEX = indexFolders([FA, FA1, FB]);

/** 我的筆記 tab 的批次 source（選取都在根層）；movingFolders 非空＝選了資料夾。 */
function mine(mode: "move" | "copy", movingFolders: FolderDto[] = []): DestSource {
  return { mode, current: PERSONAL, makeCopy: mode === "copy", others: [TEAM], locations: [null], movingFolders };
}

/** PR-2c 形（沒有上半部、沒有資料夾）：與 SelectActionBar 的過渡接法同形。 */
function flat(mode: "move" | "copy"): DestSource {
  return { mode, current: null, makeCopy: false, others: mode === "move" ? [TEAM] : [PERSONAL, TEAM], locations: [], movingFolders: [] };
}

function level(source: DestSource, path: DestPathStep[] = [], index = INDEX): DestItem[] {
  return buildDestinationLevel({ source, path, index, t });
}

function props(over: Partial<Props> = {}): Props {
  return {
    mode: "move",
    count: 3,
    hasFolders: false,
    level: level(flat("move"), [], EMPTY_FOLDER_INDEX),
    levelKey: "[]",
    error: null,
    open: true,
    onDrill: vi.fn(),
    onBack: vi.fn(),
    onPick: vi.fn(),
    onOpenChange: vi.fn(),
    ...over,
  };
}

function renderPicker(over: Partial<Props> = {}) {
  const base = props(over);
  const view = render(<DestinationPickerDialog {...base} />);
  return { ...base, rerender: (next: Partial<Props>) => view.rerender(<DestinationPickerDialog {...base} {...next} />) };
}

const dialog = () => screen.getByRole("dialog");
const list = () => dialog().querySelector("ul") as HTMLUListElement;
/** 每列：分隔線＝"---"，其餘＝按鈕的可及名稱（aria-label）。 */
const rows = () =>
  Array.from(list().children).map((li) => (li.getAttribute("role") === "separator" ? "---" : (li.querySelector("button")?.getAttribute("aria-label") ?? "?")));
const item = (name: string) => within(dialog()).getByRole("button", { name });
const CROSS_SPACE = "Folders can only move within the same space";

describe("DestinationPickerDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  // ── PR-2c 既有案（DP1–DP5），依一次一層的新 props 改寫（T6a）
  it("DP1 copy（PR-2c 形）：My notes、Team 依序，沒有「Groups」小標；圖示 user／users；按 Team → onPick 群組根層", () => {
    const { onPick } = renderPicker({ mode: "copy", level: level(flat("copy"), [], EMPTY_FOLDER_INDEX) });
    expect(within(dialog()).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["My notes", "Team"]);
    expect(within(dialog()).queryByText("Groups")).toBeNull();
    expect(item("My notes").querySelector('svg[data-icon="user"]')).not.toBeNull();
    expect(item("Team").querySelector('svg[data-icon="users"]')).not.toBeNull();
    fireEvent.click(item("Team"));
    expect(onPick).toHaveBeenCalledWith({ kind: "place", space: TEAM, folder: null });
  });

  it("DP1 copy：按 My notes → onPick 我的筆記根層", () => {
    const { onPick } = renderPicker({ mode: "copy", level: level(flat("copy"), [], EMPTY_FOLDER_INDEX) });
    fireEvent.click(item("My notes"));
    expect(onPick).toHaveBeenCalledWith({ kind: "place", space: PERSONAL, folder: null });
  });

  it("DP2 move（PR-2c 形）：沒有 My notes，只有 Team；沒有「Groups」小標", () => {
    renderPicker({ mode: "move" });
    expect(within(dialog()).queryByRole("button", { name: "My notes" })).toBeNull();
    expect(within(dialog()).queryByText("Groups")).toBeNull();
    expect(rows()).toEqual(["Team"]);
  });

  it("DP3 level null → Loading…、沒有清單", () => {
    renderPicker({ level: null });
    expect(within(dialog()).getByText("Loading…")).toBeInTheDocument();
    expect(list()).toBeNull();
  });

  it("DP3 error → role=alert（errors.<code>）", () => {
    renderPicker({ level: null, error: new ApiFail(500, "internal", "x") });
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
  });

  it("DP4 標題與描述：Move to、Choose where the 3 notes go.", () => {
    renderPicker({ mode: "move" });
    expect(screen.getByRole("dialog", { name: "Move to" })).toHaveAccessibleDescription("Choose where the 3 notes go.");
  });

  it("DP4 copy 標題 Copy to；單數描述", () => {
    renderPicker({ mode: "copy", count: 1, level: level(flat("copy"), [], EMPTY_FOLDER_INDEX) });
    expect(screen.getByRole("dialog", { name: "Copy to" })).toHaveAccessibleDescription("Choose where the note goes.");
  });

  it("DP4 zh-TW：標題複製到、根我的筆記；沒有「群組」小標", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      renderPicker({ mode: "copy", level: level(flat("copy"), [], EMPTY_FOLDER_INDEX) });
      const zh = screen.getByRole("dialog", { name: "複製到" });
      expect(within(zh).getByRole("button", { name: "我的筆記" })).toBeInTheDocument();
      expect(within(zh).queryByText("群組")).toBeNull();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("DP4 zh-TW：move 標題移動到", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      renderPicker({ mode: "move" });
      expect(screen.getByRole("dialog", { name: "移動到" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("DP5 Cancel → onOpenChange(false)、沒有 onPick", () => {
    const { onPick, onOpenChange } = renderPicker();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  // ── PR-3b-2 T6a：一次一層
  it("DPf1 第一層：A（, open）、B、分隔線、Team 依序；分隔線是 li[role=separator]；點「A, open」→ onDrill、點 B → onPick", () => {
    const { onDrill, onPick } = renderPicker({ level: level(mine("move")) });
    expect(rows()).toEqual(["A, open", "B", "---", "Team"]);
    expect(within(dialog()).getByRole("separator").tagName).toBe("LI");
    expect(item("A, open")).toHaveTextContent(/^A$/);
    expect(item("A, open").querySelector('svg[data-icon="folder"]')).not.toBeNull();
    expect(item("A, open").querySelector('svg[data-icon="chevron-right"]')).toHaveAttribute("aria-hidden", "true");
    expect(item("B").querySelector('svg[data-icon="chevron-right"]')).toBeNull();
    expect(item("Team").querySelector('svg[data-icon="users"]')).not.toBeNull();

    fireEvent.click(item("A, open"));
    expect(onDrill).toHaveBeenCalledWith({ kind: "folder", folderId: "A" });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(item("B"));
    expect(onPick).toHaveBeenCalledWith({ kind: "place", space: PERSONAL, folder: FB });
    expect(onDrill).toHaveBeenCalledTimes(1);
  });

  it("DPf1 copy 第一層：「Make a copy」copy 圖示、Top level 不放圖示；共享空間項 share 圖示", () => {
    const source: DestSource = { mode: "copy", current: PERSONAL, makeCopy: true, others: [{ kind: "shared" }], locations: ["A"], movingFolders: [] };
    renderPicker({ mode: "copy", level: level(source) });
    expect(rows()).toEqual(["Make a copy", "Top level", "A, open", "B", "---", "Shared with me"]);
    expect(item("Make a copy").querySelector('svg[data-icon="copy"]')).not.toBeNull();
    expect(item("Top level").querySelector("svg")).toBeNull();
    expect(item("Shared with me").querySelector('svg[data-icon="share"]')).not.toBeNull();
  });

  it("DPf2 以新 levelKey 渲染第二層 → 第一顆是 Back（‹ aria-hidden）且取得焦點、清單捲回頂端；點 Back → onBack", () => {
    const view = renderPicker({ level: level(mine("move")) });
    list().scrollTop = 80;
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
    view.rerender({ level: level(mine("move"), path), levelKey: JSON.stringify(path) });
    expect(rows()).toEqual(["Back", "Move here", "A1"]);
    const back = item("Back");
    expect(back).toHaveTextContent("‹ Back");
    expect(back.querySelector('[aria-hidden="true"]')).toHaveTextContent("‹");
    expect(back.querySelector("svg")).toBeNull();
    expect(item("Move here").querySelector("svg")).toBeNull();
    expect(back).toHaveFocus();
    expect(list().scrollTop).toBe(0);
    fireEvent.click(back);
    expect(view.onBack).toHaveBeenCalledTimes(1);
    expect(view.onPick).not.toHaveBeenCalled();
  });

  it("DPf2 同一個 levelKey、level 換新陣列重繪（資料夾重抓）→ 焦點不動、不捲動", () => {
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
    const view = renderPicker({ level: level(mine("move")) });
    view.rerender({ level: level(mine("move"), path), levelKey: JSON.stringify(path) });
    expect(item("Back")).toHaveFocus();
    item("A1").focus();
    list().scrollTop = 40;
    const refetched = level(mine("move"), path, indexFolders([FA, FA1, FB]));
    view.rerender({ level: refetched, levelKey: JSON.stringify(path) });
    expect(item("A1")).toHaveFocus();
    expect(list().scrollTop).toBe(40);
  });

  it("DPf2 第一項 disabled 的層 → 焦點給第一個未停用的項目", () => {
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
    const view = renderPicker({ level: level(mine("move", [FA]), path), levelKey: JSON.stringify(path), hasFolders: true });
    // 回第一層：選了 A → A 自己反灰（self）且排第一，B 可按。
    view.rerender({ level: level(mine("move", [FA])), levelKey: "[]" });
    expect(rows()).toEqual(["A", "B", "---", "Team"]);
    expect(item("A")).toBeDisabled();
    expect(item("B")).toHaveFocus();
  });

  it("DPf2 換層後整層都反灰（選了 A、B：兩個 self、Team crossSpace）→ 焦點給 footer 的 Cancel（Fix round 1）", () => {
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
    const view = renderPicker({ level: level(mine("move", [FA, FB]), path), levelKey: JSON.stringify(path), hasFolders: true });
    expect(item("Back")).toBeEnabled();
    view.rerender({ level: level(mine("move", [FA, FB])), levelKey: "[]" });
    expect(rows()).toEqual(["A", "B", "---", "Team"]);
    for (const name of ["A", "B", "Team"]) expect(item(name)).toBeDisabled();
    expect(within(dialog()).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("DPf3 crossSpace 項 disabled＋title、描述下多一行同字；沒有 crossSpace 的層沒有那行", () => {
    const view = renderPicker({ level: level(mine("move", [FB])), hasFolders: true });
    const team = item("Team");
    expect(team).toBeDisabled();
    expect(team).toHaveAttribute("title", CROSS_SPACE);
    // self 反灰不帶 title。
    expect(item("B")).toBeDisabled();
    expect(item("B")).not.toHaveAttribute("title");
    const line = within(dialog()).getByText(CROSS_SPACE);
    expect(line.tagName).toBe("P");
    expect(list()).not.toContainElement(line);
    // 說明行列進對話框的可及描述（Fix round 1）。
    expect(dialog()).toHaveAccessibleDescription(`Choose where the 3 items go. ${CROSS_SPACE}`);

    view.rerender({ level: level(mine("move")), hasFolders: false });
    expect(within(dialog()).queryByText(CROSS_SPACE)).toBeNull();
    expect(dialog()).toHaveAccessibleDescription("Choose where the 3 notes go.");
    expect(item("Team")).toBeEnabled();
    expect(item("Team")).not.toHaveAttribute("title");
  });

  it("DPf4 hasFolders → 描述「Choose where the 2 items go.」；沒有 → 「Choose where the 2 notes go.」", () => {
    // 只有上半部（群組／與我共享 tab）：沒有 crossSpace 項，描述只有這一句。
    const view = renderPicker({ count: 2, hasFolders: true, level: level({ ...mine("move", [FB]), others: [] }) });
    expect(screen.getByRole("dialog", { name: "Move to" })).toHaveAccessibleDescription("Choose where the 2 items go.");
    view.rerender({ count: 2, hasFolders: false, level: level(mine("move")) });
    expect(screen.getByRole("dialog", { name: "Move to" })).toHaveAccessibleDescription("Choose where the 2 notes go.");
  });

  it("DPf5 zh-TW：描述「選擇 2 項要放到哪裡。」、跨空間說明行；第二層「‹ 返回」（可及名稱返回）取得焦點、移動到這裡", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }];
      const view = renderPicker({ count: 2, hasFolders: true, level: level(mine("move", [FB])) });
      const zh = screen.getByRole("dialog", { name: "移動到" });
      expect(zh).toHaveAccessibleDescription("選擇 2 項要放到哪裡。 資料夾只能在同一個空間內移動");
      expect(within(zh).getByText("資料夾只能在同一個空間內移動")).toBeInTheDocument();
      expect(within(zh).getByRole("button", { name: "Team" })).toHaveAttribute("title", "資料夾只能在同一個空間內移動");
      expect(within(zh).getByRole("button", { name: "A，開啟下一層" })).toBeEnabled();
      view.rerender({ level: level(mine("move", [FB]), path), levelKey: JSON.stringify(path) });
      expect(rows()).toEqual(["返回", "移動到這裡", "A1"]);
      expect(within(zh).getByRole("button", { name: "返回" })).toHaveTextContent("‹ 返回");
      expect(within(zh).getByRole("button", { name: "返回" })).toHaveFocus();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
