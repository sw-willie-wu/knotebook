import { afterEach, describe, expect, it } from "vitest";
import { installPublicPageInstallPromptGuard } from "./install-prompt";

function fireBeforeInstallPrompt(): Event {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("installPublicPageInstallPromptGuard", () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    window.history.replaceState(null, "", "/");
  });

  it.each(["/p/abc123", "/p/alice/my-note", "/P/abc123", "/p"])("公開分享頁 %s：攔下安裝提示", (path) => {
    uninstall = installPublicPageInstallPromptGuard();
    window.history.replaceState(null, "", path);
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(true);
  });

  it.each(["/", "/notes/abc", "/login", "/n/alice/my-note", "/people", "/settings/about"])("其他頁面 %s：不攔", (path) => {
    uninstall = installPublicPageInstallPromptGuard();
    window.history.replaceState(null, "", path);
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(false);
  });

  it("看事件發生當下的路徑：從一般頁 SPA 換到公開頁後才攔，換回來就不攔", () => {
    window.history.replaceState(null, "", "/notes/abc");
    uninstall = installPublicPageInstallPromptGuard();
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(false);

    window.history.pushState(null, "", "/p/abc123");
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(true);

    window.history.pushState(null, "", "/");
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(false);
  });

  it("拆掉監聽之後，公開頁也不再攔", () => {
    installPublicPageInstallPromptGuard()();
    window.history.replaceState(null, "", "/p/abc123");
    expect(fireBeforeInstallPrompt().defaultPrevented).toBe(false);
  });
});
