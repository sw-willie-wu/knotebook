import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OAUTH_APP_IDLE_DAYS } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { McpConnectGuide } from "./McpConnectGuide";
import {
  buildClaudeCodeOauthSnippet,
  buildClaudeCodeSnippet,
  buildDesktopOauthSnippet,
  buildDesktopSnippet,
  oauthAvailable,
} from "./mcp-snippets";

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

  it("OAuth Claude Code：-s user、-t http、無 header", () => {
    expect(buildClaudeCodeOauthSnippet("https://kb.example")).toBe("claude mcp add -s user -t http knotebook https://kb.example/api/mcp");
  });

  it("OAuth Desktop：cmd /c npx mcp-remote、無 env／header／--allow-http、不含 mcpServers", () => {
    const snippet = buildDesktopOauthSnippet("https://kb.example");
    expect(parseDesktop(snippet)).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "mcp-remote", "https://kb.example/api/mcp"],
    });
    expect(snippet.startsWith('"knotebook": {')).toBe(true);
    expect(snippet).not.toContain("mcpServers");
  });

  it("oauthAvailable：https 才為真", () => {
    expect(oauthAvailable("https://x")).toBe(true);
    expect(oauthAvailable("http://x")).toBe(false);
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

  const DESC = () => i18n.t("settings.authorization.mcp.oauthDescription", { days: OAUTH_APP_IDLE_DAYS });
  const HTTPS = "https://kb.example";

  it("http（預設）：OAuth 段只有標題與 https 說明，沒有 OAuth 片段、描述與提醒；說明文字接線", () => {
    render(<McpConnectGuide />);
    expect(screen.queryByTestId("mcp-oauth-claude-code")).toBeNull();
    expect(screen.queryByTestId("mcp-oauth-claude-desktop")).toBeNull();
    expect(screen.queryByTestId("mcp-oauth-consent-note")).toBeNull();
    expect(screen.getByTestId("mcp-oauth-https-only").textContent).toBe(i18n.t("settings.authorization.mcp.oauthHttpsOnly"));
    expect(screen.getByRole("heading", { level: 3, name: i18n.t("settings.authorization.mcp.oauthTitle") })).toBeInTheDocument();
    expect(screen.queryByText(DESC())).toBeNull();
    expect(screen.getByText(i18n.t("settings.authorization.mcp.description"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("settings.authorization.mcp.patDescription"))).toBeInTheDocument();
  });

  it("https：OAuth 兩段片段、說明、提醒；PAT 兩段照舊", () => {
    render(<McpConnectGuide origin={HTTPS} />);
    expect(screen.getByText(DESC())).toBeInTheDocument();
    const code = screen.getByTestId("mcp-oauth-claude-code");
    const desktop = screen.getByTestId("mcp-oauth-claude-desktop");
    expect(code.textContent).toBe(buildClaudeCodeOauthSnippet(HTTPS));
    expect(desktop.textContent).toBe(buildDesktopOauthSnippet(HTTPS));
    expect(within(code.closest("li")!).getByText(i18n.t("settings.authorization.mcp.oauthClaudeCode"))).toBeInTheDocument();
    expect(within(desktop.closest("li")!).getByText(i18n.t("settings.authorization.mcp.oauthClaudeDesktop"))).toBeInTheDocument();
    expect(screen.getByTestId("mcp-oauth-desktop-note").textContent).toBe(i18n.t("settings.authorization.mcp.oauthDesktopNote"));
    const consent = screen.getByTestId("mcp-oauth-consent-note");
    expect(consent.textContent).toBe(
      i18n.t("settings.authorization.mcp.oauthConsentNote", {
        allow: i18n.t("authorize.allow"),
        edit: i18n.t("settings.account.apiTokensScopeEdit"),
      }),
    );
    expect(consent.textContent!.startsWith("The first time you authorize")).toBe(true);
    expect(
      i18n
        .getFixedT("zh-TW")("settings.authorization.mcp.oauthConsentNote", { allow: "允許", edit: "建立與修改筆記" })
        .startsWith("第一次授權時，"),
    ).toBe(true);
    expect(screen.getByTestId("mcp-snippet-claude-code")).toBeInTheDocument();
    expect(parseDesktop(screen.getByTestId("mcp-snippet-claude-desktop").textContent!).args).not.toContain("--allow-http");
    expect(screen.queryByTestId("mcp-oauth-https-only")).toBeNull();
  });

  it("https：Copy 鈕 5 顆，OAuth Desktop 那列的 Copy 交出該片段原文", async () => {
    render(<McpConnectGuide origin={HTTPS} />);
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(5);
    const row = screen.getByTestId("mcp-oauth-claude-desktop").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(buildDesktopOauthSnippet(HTTPS)));
  });

  it("https：每顆 Copy 鈕用 aria-describedby 指向自己那段片段（報讀器分得出是哪段）", () => {
    render(<McpConnectGuide origin={HTTPS} />);
    const ids = ["mcp-endpoint", "mcp-oauth-claude-code", "mcp-oauth-claude-desktop", "mcp-snippet-claude-code", "mcp-snippet-claude-desktop"];
    const buttons = screen.getAllByRole("button", { name: "Copy" });
    expect(buttons).toHaveLength(ids.length);
    buttons.forEach((b, i) => {
      const target = document.getElementById(b.getAttribute("aria-describedby") ?? "");
      expect(target, `button ${i} 的 aria-describedby`).toBe(screen.getByTestId(ids[i]!));
    });
  });

  it("兩個 h3 依序為 OAuth、PAT；不再有編號；清單不縮排（W24）：https 2 個、http 1 個", () => {
    const { container, unmount } = render(<McpConnectGuide origin={HTTPS} />);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      i18n.t("settings.authorization.mcp.oauthTitle"),
      i18n.t("settings.authorization.mcp.patTitle"),
    ]);
    expect(container.textContent).not.toContain("1. ");
    // 片段在各自標題底下：OAuth 片段在 OAuth 標題之後、PAT 標題之前；PAT 片段在 PAT 標題之後
    const [oauthH3, patH3] = screen.getAllByRole("heading", { level: 3 });
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    for (const id of ["mcp-oauth-claude-code", "mcp-oauth-claude-desktop", "mcp-oauth-consent-note"]) {
      const el = screen.getByTestId(id);
      expect(oauthH3!.compareDocumentPosition(el) & FOLLOWING, `${id} 在 OAuth 標題之後`).toBeTruthy();
      expect(patH3!.compareDocumentPosition(el) & FOLLOWING, `${id} 在 PAT 標題之前`).toBeFalsy();
    }
    for (const id of ["mcp-snippet-claude-code", "mcp-snippet-claude-desktop"]) {
      expect(patH3!.compareDocumentPosition(screen.getByTestId(id)) & FOLLOWING, `${id} 在 PAT 標題之後`).toBeTruthy();
    }
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(2);
    for (const l of lists) expect(l).toHaveClass("list-none", "pl-0");
    unmount();
    render(<McpConnectGuide />);
    const httpLists = screen.getAllByRole("list");
    expect(httpLists).toHaveLength(1);
    expect(httpLists[0]).toHaveClass("list-none", "pl-0");
  });

  it("權限對照一句、按鈕都是 outline", () => {
    render(<McpConnectGuide />);
    expect(screen.getByText(i18n.t("settings.authorization.mcp.scopes"))).toBeInTheDocument();
    expect(screen.queryAllByRole("button").every((b) => b.classList.contains("border-input"))).toBe(true); // 都是 outline
  });
});
