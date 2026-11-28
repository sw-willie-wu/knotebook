import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/notifications-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import notificationsEn from "./notifications.en.json";
import notificationsZhTW from "./notifications.zh-TW.json";

// The notification list's strings live in a lazy bundle; only the bell button's two (`notificationBell.*`) are in the main files.

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
}

const lookup = (obj: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);

describe("notifications lazy bundle", () => {
  it("has the same keys and placeholders in both locales", () => {
    const keys = flattenKeys(notificationsEn).sort();
    expect(flattenKeys(notificationsZhTW).sort()).toEqual(keys);
    for (const key of keys) expect(placeholders(lookup(notificationsZhTW, key) as string), key).toEqual(placeholders(lookup(notificationsEn, key) as string));
  });

  it("does not overlap the main files, which keep only the bell button's strings", () => {
    for (const raw of [enRaw, zhTWRaw]) {
      const main = JSON.parse(raw) as { notifications?: unknown; notificationBell: Record<string, string> };
      expect(main.notifications).toBeUndefined();
      expect(Object.keys(main.notificationBell).sort()).toEqual(["label", "unread"]);
    }
  });

  it("resolves after registration, in Taiwan usage for zh-TW", () => {
    expect(i18n.t("notifications.cantOpen", { lng: "en" })).toBe("You can't open this note any more.");
    expect(i18n.t("notifications.title", { lng: "zh-TW" })).toBe("通知");
    expect(i18n.t("notifications.replied", { lng: "zh-TW", who: "Bob" })).toBe("Bob 回覆了你的留言");
    expect(i18n.t("notificationBell.unread", { lng: "zh-TW", count: 3 })).toBe("通知，3 則未讀");
    expect(i18n.t("notificationBell.unread", { lng: "en", count: 3 })).toBe("Notifications, 3 unread");
  });

  it("is imported by every notifications module that renders a lazy key, and by nothing outside the lazy chunk", () => {
    const dir = join(process.cwd(), "src/components/notifications");
    const lazyKey = /\bt\(\s*["'`]notifications\./;
    for (const name of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes(".test."))) {
      const src = readFileSync(join(dir, name), "utf8");
      if (lazyKey.test(src)) expect(src, name).toMatch(/import\s+["']@\/i18n\/notifications-strings["']/);
    }
    for (const path of [
      "src/components/NotificationBell.tsx",
      "src/components/ui/sidebar-panel-lazy-boundary.tsx",
      "src/components/AppShell.tsx",
      "src/components/UserMenu.tsx",
      "src/lib/notification-live.ts",
      "src/lib/notification-socket.ts",
      "src/api/notifications.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), path), "utf8"), path).not.toMatch(/notifications-strings|notifications-list/);
    }
  });
});
