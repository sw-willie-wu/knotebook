import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { SetPasswordForm } from "@/settings/SetPasswordForm";

function wrap(node: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
}

const PASSWORD_FIELD_IDS = ["change-password-current", "change-password-new", "change-password-confirm"];

describe("密碼表單在面板內的送出鈕（#247）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it('ChangePasswordForm tone="outline" → 送出鈕是 outline、不是實心、不滿寬', () => {
    const { container } = wrap(<ChangePasswordForm tone="outline" onSuccess={() => {}} />);
    const submit = screen.getByRole("button", { name: "Change password" });
    expect(submit).toHaveClass("border-input");
    expect(submit).not.toHaveClass("bg-brand-deep");
    expect(submit).not.toHaveClass("bg-brand");
    expect(submit).not.toHaveClass("w-full");
    // 設定 modal 內維持 32px（ui/button.tsx 例外二：只有 tone="page" 放大）
    expect(submit).toHaveClass("h-8");
    expect(submit).not.toHaveClass("h-11");
    for (const id of PASSWORD_FIELD_IDS) {
      expect(container.querySelector(`#${id}`)).not.toHaveClass("h-11");
    }
  });

  it('ChangePasswordForm 預設 tone（"page"，/change-password 整頁）→ brandSolid 滿寬，行為不變', () => {
    const { container } = wrap(<ChangePasswordForm onSuccess={() => {}} />);
    const submit = screen.getByRole("button", { name: "Change password" });
    expect(submit).toHaveClass("bg-brand", "w-full", "h-11");
    for (const id of PASSWORD_FIELD_IDS) {
      expect(container.querySelector(`#${id}`)).toHaveClass("h-11");
    }
  });

  it("SetPasswordForm 送出鈕是 outline", () => {
    wrap(<SetPasswordForm onSuccess={() => {}} />);
    const submit = screen.getByRole("button", { name: "Add password" });
    expect(submit).toHaveClass("border-input");
    expect(submit).not.toHaveClass("bg-brand-deep");
  });
});
