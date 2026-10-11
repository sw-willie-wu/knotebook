import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { REPO_URL } from "./about-links";
import { buildClaudeCodeSnippet, buildDesktopSnippet, mcpEndpoint } from "./mcp-snippets";
import { SettingsGroup } from "./SettingsLayout";

/** 與關於頁同形：由 REPO_URL 組出，指向 docs/mcp.md 的 How to connect（Windows 上 Desktop 包 `cmd /c` 的寫法在那裡）。 */
const MCP_DOCS_URL = `${REPO_URL}/blob/main/docs/mcp.md#how-to-connect`;
const LINK_CLASS = "text-brand-on-soft underline-offset-4 hover:underline";

/**
 * 「用 MCP 連接 Claude」（#247 §5.3、W10）：本站端點、Claude Code／Claude Desktop 兩段設定片段（組裝在
 * `mcp-snippets.ts`；token 位置一律 `<YOUR_TOKEN>` 佔位，**不自動帶入任何 token 值**）、一句權限對照（與
 * docs/mcp.md 工具表同步）。Bearer header 是 PAT 那條路；OAuth 那條路（`claude mcp login`）見 docs/mcp.md How to connect。
 * ⚠ 這是 user-facing 文件敘述：改片段前照 memory `g:doc-claim-audit-apparatus` 對 demo 實連一次。
 */
export function McpConnectGuide() {
  const { t } = useTranslation();
  const origin = window.location.origin;
  const endpoint = mcpEndpoint(origin);
  const claudeCode = buildClaudeCodeSnippet(origin);
  const claudeDesktop = buildDesktopSnippet(origin);

  async function copy(text: string): Promise<void> {
    const ok = await copyText(text);
    toast(ok ? { title: t("settings.authorization.mcp.copied") } : { title: t("settings.authorization.mcp.copyFailed"), variant: "destructive" });
  }

  const steps: Array<{ label: string; text: string; testId: string }> = [
    { label: t("settings.authorization.mcp.endpoint"), text: endpoint, testId: "mcp-endpoint" },
    { label: t("settings.authorization.mcp.claudeCode"), text: claudeCode, testId: "mcp-snippet-claude-code" },
    { label: t("settings.authorization.mcp.claudeDesktop"), text: claudeDesktop, testId: "mcp-snippet-claude-desktop" },
  ];

  return (
    <SettingsGroup title={t("settings.authorization.mcp.title")} description={t("settings.authorization.mcp.description")}>
      <ol className="list-none space-y-4 pl-0 text-sm">
        {steps.map((step, i) => (
          <li key={step.testId} className="space-y-1">
            <p>
              <span className="font-semibold">{i + 1}. </span>
              {step.label}
            </p>
            <div className="flex items-start gap-2">
              <pre
                data-testid={step.testId}
                className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
              >
                {step.text}
              </pre>
              <Button type="button" variant="outline" size="sm" onClick={() => void copy(step.text)}>
                {t("settings.authorization.mcp.copy")}
              </Button>
            </div>
            {step.testId === "mcp-snippet-claude-desktop" && (
              <p data-testid="mcp-windows-note" className="text-xs text-muted-foreground">
                {t("settings.authorization.mcp.windowsNote")}{" "}
                <a href={MCP_DOCS_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                  {t("settings.authorization.mcp.windowsNoteLink")}
                </a>
              </p>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-muted-foreground">{t("settings.authorization.mcp.scopes")}</p>
    </SettingsGroup>
  );
}
