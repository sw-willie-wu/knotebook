import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/comments-strings";
import "@/i18n/comment-toolbar-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import commentsEn from "./comments.en.json";
import commentsZhTW from "./comments.zh-TW.json";
import toolbarEn from "./comment-toolbar.en.json";
import toolbarZhTW from "./comment-toolbar.zh-TW.json";

// The comments panel's strings live in a lazy bundle; only `note.menu.comments` (⋮ item and bubble name) is in the main files.

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
}

const lookup = (obj: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);

describe("comments lazy bundle", () => {
  it("has the same keys and placeholders in both locales", () => {
    const keys = flattenKeys(commentsEn).sort();
    expect(flattenKeys(commentsZhTW).sort()).toEqual(keys);
    for (const key of keys) expect(placeholders(lookup(commentsZhTW, key) as string), key).toEqual(placeholders(lookup(commentsEn, key) as string));
  });

  it("does not overlap the main files, which keep only the menu label", () => {
    for (const raw of [enRaw, zhTWRaw]) {
      const main = JSON.parse(raw) as { comments?: unknown; note: { menu: Record<string, string> } };
      expect(main.comments).toBeUndefined();
      expect(typeof main.note.menu.comments).toBe("string");
    }
  });

  it("resolves after registration, in Taiwan usage for zh-TW", () => {
    expect(i18n.t("comments.answeredDeleted", { lng: "en" })).toBe("The comment it answered was deleted.");
    expect(i18n.t("comments.reply", { lng: "zh-TW" })).toBe("回覆");
    expect(i18n.t("comments.edit", { lng: "zh-TW" })).toBe("編輯");
    expect(i18n.t("comments.delete", { lng: "zh-TW" })).toBe("刪除");
    expect(i18n.t("comments.title", { lng: "zh-TW" })).toBe("留言");
    expect(i18n.t("note.menu.comments", { lng: "zh-TW" })).toBe("留言");
    expect(i18n.t("comments.composer.replyingTo", { lng: "en", who: "Bob" })).toBe("Replying to Bob");
  });

  it("is imported by every comments module that renders a lazy key, and by nothing outside the lazy chunk", () => {
    const dir = join(process.cwd(), "src/components/comments");
    const lazyKey = /\bt\(\s*["'`]comments\./;
    for (const name of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes(".test."))) {
      const src = readFileSync(join(dir, name), "utf8");
      if (lazyKey.test(src)) expect(src, name).toMatch(/import\s+["']@\/i18n\/comments-strings["']/);
    }
    for (const path of [
      "src/components/comments/CommentsLazyBoundary.tsx",
      "src/components/comments/PassageCommentButton.tsx",
      "src/components/comments/ViewerCommentToolbar.tsx",
      "src/components/comments/passage.ts",
      "src/components/ai/AiToolbar.tsx",
      "src/components/CornerStack.tsx",
      "src/components/NoteMenu.tsx",
      "src/components/NoteEditor.tsx",
      "src/pages/NotePage.tsx",
      "src/lib/comments-context.tsx",
    ]) {
      expect(readFileSync(join(process.cwd(), path), "utf8"), path).not.toMatch(/comments-strings/);
    }
  });
});

// The selection toolbars' Comment button sits outside the lazy chunk, so its one string has its own small pack.
describe("comment toolbar pack", () => {
  it("has the same keys in both locales, under commentToolbar only, and overlaps neither the main files nor the comments pack", () => {
    expect(Object.keys(toolbarEn)).toEqual(["commentToolbar"]);
    expect(flattenKeys(toolbarZhTW).sort()).toEqual(flattenKeys(toolbarEn).sort());
    for (const raw of [enRaw, zhTWRaw]) expect((JSON.parse(raw) as { commentToolbar?: unknown }).commentToolbar).toBeUndefined();
    expect((commentsEn as { commentToolbar?: unknown }).commentToolbar).toBeUndefined();
  });

  it("resolves after registration, in Taiwan usage for zh-TW", () => {
    expect(i18n.t("commentToolbar.comment", { lng: "en" })).toBe("Comment");
    expect(i18n.t("commentToolbar.comment", { lng: "zh-TW" })).toBe("留言");
  });

  it("is imported by the module that renders it", () => {
    const src = readFileSync(join(process.cwd(), "src/components/comments/PassageCommentButton.tsx"), "utf8");
    expect(src).toMatch(/import\s+["']@\/i18n\/comment-toolbar-strings["']/);
  });
});
