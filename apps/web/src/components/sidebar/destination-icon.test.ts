import { describe, expect, it } from "vitest";
import { ChevronLeft, Folder } from "@/components/ui/icons";
import { destinationItemIcon } from "./destination-icon";
import type { DestItem } from "./destination-level";

describe("destinationItemIcon", () => {
  it("DI1 back -> ChevronLeft；root、here -> null；folder -> Folder", () => {
    expect(destinationItemIcon({ kind: "back" } as DestItem)).toBe(ChevronLeft);
    expect(destinationItemIcon({ kind: "root" } as DestItem)).toBeNull();
    expect(destinationItemIcon({ kind: "here" } as DestItem)).toBeNull();
    expect(destinationItemIcon({ kind: "folder" } as DestItem)).toBe(Folder);
  });
});
