import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { __resetCollapseForTests } from "./collapse";
import { __resetFolderSortForTests, folderSortOf, setFolderSort, useFolderSort, useFolderSortOf, type FolderSort } from "./folder-sort";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

function throwQuota(): never {
  throw new DOMException("quota", "QuotaExceededError");
}

function SortProbe({ id, folderId }: { id: string; folderId: string }) {
  return <span data-testid={id}>{useFolderSort(folderId)}</span>;
}

describe("folder-sort store", () => {
  it("FS1 沒存過 → recent", () => {
    expect(folderSortOf("f1")).toBe("recent");
  });

  it("FS2 setFolderSort(\"f1\",\"name\") → localStorage 存字面值、folderSortOf 回 name；\"recent\" 也寫字面值", () => {
    setFolderSort("f1", "name");
    expect(localStorage.getItem("sidebar.sort.folder:f1")).toBe("name");
    expect(folderSortOf("f1")).toBe("name");
    setFolderSort("f1", "recent");
    expect(localStorage.getItem("sidebar.sort.folder:f1")).toBe("recent");
  });

  it("FS3 存的值不認得 → 預設", () => {
    localStorage.setItem("sidebar.sort.folder:f1", "bogus");
    expect(folderSortOf("f1")).toBe("recent");
  });

  it("FS4 setItem 丟例外 → 覆蓋層生效（先查覆蓋層：localStorage 裡的舊值不會蓋掉剛選的）", () => {
    localStorage.setItem("sidebar.sort.folder:f1", "size");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(throwQuota);
    expect(() => setFolderSort("f1", "name")).not.toThrow();
    expect(localStorage.getItem("sidebar.sort.folder:f1")).toBe("size");
    expect(folderSortOf("f1")).toBe("name");
  });

  it("FS4b getItem 丟例外 → folderSortOf 回預設、useFolderSort 不崩", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(throwQuota);
    expect(folderSortOf("f1")).toBe("recent");
    render(<SortProbe id="a" folderId="f1" />);
    expect(screen.getByTestId("a")).toHaveTextContent("recent");
  });

  it("FS5 同一 id 兩個元件：一處改另一處重繪；setFolderSort 後 useFolderSortOf 換新函式且查得到新值，沒變動時重繪回同一個", () => {
    const seen: Array<(folderId: string) => FolderSort> = [];
    function SortOfProbe({ tick }: { tick: number }) {
      seen.push(useFolderSortOf());
      return <span data-testid="tick">{tick}</span>;
    }
    const { rerender } = render(
      <>
        <SortProbe id="a" folderId="f1" />
        <SortProbe id="b" folderId="f1" />
        <SortOfProbe tick={0} />
      </>,
    );
    rerender(
      <>
        <SortProbe id="a" folderId="f1" />
        <SortProbe id="b" folderId="f1" />
        <SortOfProbe tick={1} />
      </>,
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);

    act(() => {
      setFolderSort("f1", "size");
    });
    expect(screen.getByTestId("a")).toHaveTextContent("size");
    expect(screen.getByTestId("b")).toHaveTextContent("size");
    expect(seen.at(-1)).not.toBe(seen[0]);
    expect(seen.at(-1)!("f1")).toBe("size");
  });
});
