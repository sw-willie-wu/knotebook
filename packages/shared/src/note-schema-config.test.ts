import { describe, expect, it } from "vitest";
import {
  SUPPORTED_LANGUAGES,
  normalizeCodeBlockLanguage,
  resolveCodeBlockLanguage,
} from "./note-schema-config.js";

describe("resolveCodeBlockLanguage (#590)", () => {
  it("resolves every canonical language id and alias regardless of case or surrounding whitespace", () => {
    for (const [id, spec] of Object.entries(SUPPORTED_LANGUAGES)) {
      expect(resolveCodeBlockLanguage(id)).toBe(id);
      expect(resolveCodeBlockLanguage(id.toUpperCase())).toBe(id);
      expect(resolveCodeBlockLanguage(`  ${id[0]!.toUpperCase()}${id.slice(1)}  `)).toBe(id);
      for (const alias of spec.aliases ?? []) {
        expect(resolveCodeBlockLanguage(alias)).toBe(id);
        expect(resolveCodeBlockLanguage(alias.toUpperCase())).toBe(id);
      }
    }
  });

  it("handles common mixed-case names and aliases", () => {
    expect(resolveCodeBlockLanguage("Python")).toBe("python");
    expect(resolveCodeBlockLanguage("PY")).toBe("python");
    expect(resolveCodeBlockLanguage("LaTeX")).toBe("latex");
    expect(resolveCodeBlockLanguage("TypeScript")).toBe("typescript");
    expect(resolveCodeBlockLanguage("TS")).toBe("typescript");
    expect(resolveCodeBlockLanguage("JavaScript")).toBe("javascript");
    expect(resolveCodeBlockLanguage("JS")).toBe("javascript");
    expect(resolveCodeBlockLanguage("C++")).toBe("cpp");
    expect(resolveCodeBlockLanguage("C#")).toBe("csharp");
    expect(resolveCodeBlockLanguage("Dockerfile")).toBe("docker");
    expect(resolveCodeBlockLanguage("Shell")).toBe("bash");
    expect(resolveCodeBlockLanguage("ZSH")).toBe("bash");
    expect(resolveCodeBlockLanguage("Plaintext")).toBe("text");
    expect(resolveCodeBlockLanguage("TXT")).toBe("text");
  });

  it("returns undefined for empty, mermaid, tex, and unknown languages", () => {
    expect(resolveCodeBlockLanguage("")).toBeUndefined();
    expect(resolveCodeBlockLanguage("   ")).toBeUndefined();
    expect(resolveCodeBlockLanguage(null)).toBeUndefined();
    expect(resolveCodeBlockLanguage(undefined)).toBeUndefined();
    expect(resolveCodeBlockLanguage("mermaid")).toBeUndefined();
    expect(resolveCodeBlockLanguage("Mermaid")).toBeUndefined();
    expect(resolveCodeBlockLanguage("tex")).toBeUndefined();
    expect(resolveCodeBlockLanguage("TeX")).toBeUndefined();
    expect(resolveCodeBlockLanguage("notalang")).toBeUndefined();
    expect(resolveCodeBlockLanguage("Ruby")).toBeUndefined();
  });
});

describe("normalizeCodeBlockLanguage (#590)", () => {
  it("normalizes supported languages and aliases to their canonical lowercase id", () => {
    expect(normalizeCodeBlockLanguage("Python")).toBe("python");
    expect(normalizeCodeBlockLanguage("PY")).toBe("python");
    expect(normalizeCodeBlockLanguage("LaTeX")).toBe("latex");
    expect(normalizeCodeBlockLanguage("TS")).toBe("typescript");
    expect(normalizeCodeBlockLanguage("C++")).toBe("cpp");
    expect(normalizeCodeBlockLanguage("C#")).toBe("csharp");
    expect(normalizeCodeBlockLanguage("Dockerfile")).toBe("docker");
    expect(normalizeCodeBlockLanguage("Plaintext")).toBe("text");
  });

  it("normalizes mermaid regardless of case so diagram conversions match uniformly", () => {
    expect(normalizeCodeBlockLanguage("mermaid")).toBe("mermaid");
    expect(normalizeCodeBlockLanguage("Mermaid")).toBe("mermaid");
    expect(normalizeCodeBlockLanguage("MERMAID")).toBe("mermaid");
    expect(normalizeCodeBlockLanguage("  Mermaid  ")).toBe("mermaid");
  });

  it("returns undefined for empty/blank input and preserves unknown language names trimmed", () => {
    expect(normalizeCodeBlockLanguage("")).toBeUndefined();
    expect(normalizeCodeBlockLanguage("   ")).toBeUndefined();
    expect(normalizeCodeBlockLanguage(null)).toBeUndefined();
    expect(normalizeCodeBlockLanguage(undefined)).toBeUndefined();
    expect(normalizeCodeBlockLanguage("notalang")).toBe("notalang");
    expect(normalizeCodeBlockLanguage("  Ruby  ")).toBe("Ruby");
    expect(normalizeCodeBlockLanguage("TeX")).toBe("TeX");
  });
});
