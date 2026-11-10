import { describe, expect, it } from "vitest";
import { ChevronLeft, CornerDownRight, Folder, House } from "@/components/ui/icons";
import { destinationItemIcon } from "./destination-icon";
import type { DestItem } from "./destination-level";

describe("destinationItemIcon", () => {
  it("back -> ChevronLeft；root -> House；here -> CornerDownRight；folder -> Folder", () => {
    expect(destinationItemIcon({ kind: "back" } as DestItem)).toBe(ChevronLeft);
    expect(destinationItemIcon({ kind: "root" } as DestItem)).toBe(House);
    expect(destinationItemIcon({ kind: "here" } as DestItem)).toBe(CornerDownRight);
    expect(destinationItemIcon({ kind: "folder" } as DestItem)).toBe(Folder);
  });
});
