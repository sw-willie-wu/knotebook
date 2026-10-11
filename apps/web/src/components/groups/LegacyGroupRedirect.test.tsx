import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType, type Location } from "react-router";
import { LegacyGroupRedirect } from "./GroupModal";

function Probe() {
  const location = useLocation();
  const navType = useNavigationType();
  const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  return (
    <div data-testid="probe" data-nav={navType} data-bg={bg?.pathname ?? ""}>
      {location.pathname}
    </div>
  );
}

function renderAt(entry: { pathname: string; state?: unknown }) {
  render(
    <MemoryRouter initialEntries={[{ pathname: entry.pathname, state: entry.state ?? null }]}>
      <Routes>
        <Route path="/settings/groups/:id" element={<LegacyGroupRedirect suffix="" />} />
        <Route path="/settings/groups/:id/roles" element={<LegacyGroupRedirect suffix="/roles" />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const BG = { pathname: "/n/tester/my-note", search: "", hash: "", state: null, key: "bg" } as Location;

describe("LegacyGroupRedirect（#247 §5.1）", () => {
  it("/settings/groups/:id → /groups/:id，參數代入、replace", async () => {
    renderAt({ pathname: "/settings/groups/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/groups/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
    expect(screen.getByTestId("probe")).toHaveAttribute("data-nav", "REPLACE");
  });

  it("/settings/groups/:id/roles → /groups/:id/roles", async () => {
    renderAt({ pathname: "/settings/groups/g1/roles" });
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent(/^\/groups\/g1\/roles$/));
  });

  it("id 以 encodeURIComponent 代回（useParams 已解碼）", async () => {
    renderAt({ pathname: "/settings/groups/a%20b%2Fc" });
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/groups/a%20b%2Fc"));
  });

  it("轉傳 location.state：舊網址帶 backgroundLocation 進來，轉址後仍在（突變：拿掉 state 轉傳要紅）", async () => {
    renderAt({ pathname: "/settings/groups/g1", state: { backgroundLocation: BG } });
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/groups/g1"));
    expect(screen.getByTestId("probe")).toHaveAttribute("data-bg", "/n/tester/my-note");
  });
});
