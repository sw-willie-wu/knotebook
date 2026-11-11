import { describe, expect, it, vi } from "vitest";
import type { Location } from "react-router";
import { openSettings } from "./open-settings";

describe("openSettings", () => {
  it("導到 /settings/account，並帶目前 location 當 backgroundLocation", () => {
    const navigate = vi.fn();
    const location = { pathname: "/n/tester/my-note", search: "?x=1", hash: "#b-1", state: null, key: "k" } as Location;
    openSettings(navigate, location);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/settings/account", { state: { backgroundLocation: location } });
  });
});
