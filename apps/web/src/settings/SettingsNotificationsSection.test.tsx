import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NotificationSettingsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { NOTIFICATION_SETTINGS_QUERY_KEY } from "@/api/admin-notifications";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SiteNotificationsGroup } from "./SettingsNotificationsSection";

const URL_ = "/api/admin/notifications/settings";
const INVALID = "Use a whole number from 1 to 3650.";

function res(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

interface Server {
  settings: NotificationSettingsDto;
  get?: () => Promise<Response>;
  patch?: (body: unknown) => Response | Promise<Response>;
}

function setup(server: Server) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === URL_ && method === "GET") return server.get ? server.get() : Promise.resolve(res(200, server.settings));
    if (url === URL_ && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as NotificationSettingsDto;
      return Promise.resolve(server.patch ? server.patch(body) : res(200, body));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SiteNotificationsGroup />
      <Toaster />
    </QueryClientProvider>,
  );
  const patches = () =>
    fetchMock.mock.calls
      .filter(([u, i]) => String(u) === URL_ && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "PATCH")
      .map(([, i]) => String((i as RequestInit).body));
  return { queryClient, patches };
}

const area = () => within(screen.getByRole("region", { name: "Notifications" }));
const daysField = () => area().getByLabelText("Days to keep notifications");
const toggle = () => screen.findByRole("switch", { name: "Delete old notifications automatically" });
const save = () => fireEvent.click(area().getByRole("button", { name: "Save" }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("SiteNotificationsGroup (notification retention)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the current value", async () => {
    setup({ settings: { retentionDays: 14 } });
    expect(await toggle()).toHaveAttribute("aria-checked", "true");
    expect(daysField()).toHaveValue("14");
  });

  it("Save sends the days through PATCH and shows a toast", async () => {
    const { patches } = setup({ settings: { retentionDays: 30 } });
    await toggle();
    fireEvent.change(daysField(), { target: { value: "90" } });
    save();
    expect(await screen.findByText("Notification settings saved", { exact: true })).toBeInTheDocument();
    expect(patches()).toEqual(['{"retentionDays":90}']);
  });

  it("accepts the bounds 1 and 3650", async () => {
    const { patches } = setup({ settings: { retentionDays: 30 } });
    await toggle();
    for (const [i, value] of ["1", "3650"].entries()) {
      fireEvent.change(daysField(), { target: { value } });
      save();
      await waitFor(() => expect(patches()).toHaveLength(i + 1));
      await waitFor(() => expect(area().getByRole("button", { name: "Save" })).not.toBeDisabled());
    }
    expect(patches()).toEqual(['{"retentionDays":1}', '{"retentionDays":3650}']);
  });

  it("0 / 3651 / abc / 1.5 / empty are refused inline and not sent", async () => {
    const { patches } = setup({ settings: { retentionDays: 30 } });
    await toggle();
    for (const value of ["0", "3651", "abc", "1.5", ""]) {
      fireEvent.change(daysField(), { target: { value } });
      save();
      expect(await area().findByRole("alert")).toHaveTextContent(INVALID);
    }
    await tick();
    expect(patches()).toEqual([]);
  });

  it("Never delete: turning the switch off hides the days and saves null", async () => {
    const { patches } = setup({ settings: { retentionDays: 30 } });
    fireEvent.click(await toggle());
    expect(area().queryByLabelText("Days to keep notifications")).not.toBeInTheDocument();
    save();
    await waitFor(() => expect(patches()).toEqual(['{"retentionDays":null}']));
  });

  it("server null shows the switch off; turning it on offers 30 and nothing is sent until Save", async () => {
    const { patches } = setup({ settings: { retentionDays: null } });
    const sw = await toggle();
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(daysField()).toHaveValue("30");
    await tick();
    expect(patches()).toEqual([]);
  });

  it("after a save the form follows the server value again", async () => {
    const server: Server = { settings: { retentionDays: 30 } };
    const { queryClient } = setup(server);
    await toggle();
    fireEvent.change(daysField(), { target: { value: "60" } });
    save();
    await screen.findByText("Notification settings saved", { exact: true });
    server.settings = { retentionDays: 45 };
    await queryClient.invalidateQueries({ queryKey: NOTIFICATION_SETTINGS_QUERY_KEY });
    await waitFor(() => expect(daysField()).toHaveValue("45"));
  });

  it("PATCH 400 shows the mapped error and no toast", async () => {
    setup({ settings: { retentionDays: 30 }, patch: () => res(400, { error: { code: "invalid_body", message: "x" } }) });
    await toggle();
    fireEvent.change(daysField(), { target: { value: "9" } });
    save();
    expect(await area().findByRole("alert")).toHaveTextContent(i18n.t("errors.invalid_body"));
    expect(screen.queryByText("Notification settings saved")).not.toBeInTheDocument();
  });

  it("Save is disabled while the PATCH is pending", async () => {
    let release: (r: Response) => void = () => {};
    const { patches } = setup({ settings: { retentionDays: 30 }, patch: () => new Promise<Response>((resolve) => (release = resolve)) });
    await toggle();
    fireEvent.change(daysField(), { target: { value: "9" } });
    save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(area().getByRole("button", { name: "Save" })).toBeDisabled();
    release(res(200, { retentionDays: 9 }));
    await waitFor(() => expect(area().getByRole("button", { name: "Save" })).not.toBeDisabled());
  });

  it("GET failure shows an alert in the same-titled region", async () => {
    setup({ settings: { retentionDays: 30 }, get: () => Promise.resolve(res(500, { error: { code: "boom", message: "x" } })) });
    expect(await area().findByRole("alert")).toHaveTextContent(i18n.t("errors.fallback"));
    expect(area().queryByRole("switch")).not.toBeInTheDocument();
  });

  it("zh-TW labels", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ settings: { retentionDays: 30 } });
    expect(await screen.findByRole("switch", { name: "自動刪除" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "通知" })).toBeInTheDocument();
  });
});
