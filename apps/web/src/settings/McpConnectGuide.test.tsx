import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { McpConnectGuide } from "./McpConnectGuide";
import { buildClaudeCodeSnippet, buildDesktopSnippet } from "./mcp-snippets";

const copyText = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/clipboard", () => ({ copyText }));

interface DesktopEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Desktop 片段只有 `"knotebook": {…}` 一段（不含外層 mcpServers）；包一層大括號才是合法 JSON。 */
function parseDesktop(snippet: string): DesktopEntry {
  const parsed = JSON.parse(`{${snippet}}`) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(["knotebook"]);
  return parsed.knotebook as DesktopEntry;
}

describe("mcp-snippets（純函式）", () => {
  it("Claude Code：-s user、http transport、Bearer <YOUR_TOKEN>", () => {
    expect(buildClaudeCodeSnippet("https://kb.example")).toBe(
      'claude mcp add -s user --transport http knotebook https://kb.example/api/mcp --header "Authorization: Bearer <YOUR_TOKEN>"',
    );
  });

  it("Desktop：header 值放 env（args 不含空白的 Bearer 值），http:// 才加 --allow-http", () => {
    const http = parseDesktop(buildDesktopSnippet("http://kb.lan:8006"));
    expect(http).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote", "http://kb.lan:8006/api/mcp", "--header", "Authorization:${AUTH_HEADER}", "--allow-http"],
      env: { AUTH_HEADER: "Bearer <YOUR_TOKEN>" },
    });
    expect(http.args.some((a) => a.includes(" "))).toBe(false);

    const https = parseDesktop(buildDesktopSnippet("https://kb.example"));
    expect(https.args).not.toContain("--allow-http");
    expect(https.args).toContain("Authorization:${AUTH_HEADER}");
    expect(https.env).toEqual({ AUTH_HEADER: "Bearer <YOUR_TOKEN>" });
  });

  it("Desktop 片段不含外層 mcpServers", () => {
    expect(buildDesktopSnippet("https://kb.example")).not.toContain("mcpServers");
    expect(buildDesktopSnippet("https://kb.example").startsWith('"knotebook": {')).toBe(true);
  });
});

describe("McpConnectGuide（#247 §5.3）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    copyText.mockClear();
  });

  const endpoint = () => `${window.location.origin}/api/mcp`;

  it("端點＝目前 origin＋/api/mcp", () => {
    render(<McpConnectGuide />);
    expect(screen.getByTestId("mcp-endpoint")).toHaveTextContent(endpoint());
  });

  it("兩段片段以目前 origin 組出、用 <YOUR_TOKEN> 佔位，不含任何真 token", () => {
    render(<McpConnectGuide />);
    expect(screen.getByTestId("mcp-snippet-claude-code").textContent).toBe(buildClaudeCodeSnippet(window.location.origin));
    const desktop = parseDesktop(screen.getByTestId("mcp-snippet-claude-desktop").textContent!);
    expect(desktop.args).toContain(endpoint());
    expect(desktop.env.AUTH_HEADER).toBe("Bearer <YOUR_TOKEN>");
  });

  it("http:// 站台 → Desktop 片段帶 --allow-http（mcp-remote 對非 https 的明示放行，docs/mcp.md How to connect）", () => {
    render(<McpConnectGuide />);
    const args = parseDesktop(screen.getByTestId("mcp-snippet-claude-desktop").textContent!).args;
    expect(window.location.protocol).toBe("http:");
    expect(args).toContain("--allow-http");
  });

  it("Desktop 片段下方有 Windows 包 cmd /c 的提示，連到 repo 的 docs/mcp.md How to connect", () => {
    render(<McpConnectGuide />);
    expect(screen.getByTestId("mcp-windows-note")).toHaveTextContent(i18n.t("settings.authorization.mcp.windowsNote"));
    expect(screen.getByRole("link", { name: "See docs/mcp.md" })).toHaveAttribute(
      "href",
      "https://github.com/sw-willie-wu/knotebook/blob/main/docs/mcp.md#how-to-connect",
    );
  });

  it("複製鈕把對應片段原文交給 copyText，成功 toast", async () => {
    render(
      <>
        <McpConnectGuide />
        <Toaster />
      </>,
    );
    const buttons = screen.getAllByRole("button", { name: "Copy" });
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(screen.getByTestId("mcp-snippet-claude-code").textContent));
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });

  it("權限對照一句、步驟清單不縮排（W24）", () => {
    render(<McpConnectGuide />);
    expect(screen.getByText(i18n.t("settings.authorization.mcp.scopes"))).toBeInTheDocument();
    expect(screen.getByRole("list")).toHaveClass("list-none", "pl-0");
    expect(screen.queryAllByRole("button").every((b) => b.classList.contains("border-input"))).toBe(true); // 都是 outline
  });
});
