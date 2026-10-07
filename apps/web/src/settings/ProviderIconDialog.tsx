import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { resolveProviderIcon, type AdminAuthProviderDto, type ProviderIconDto, type ProviderIconKind } from "@knotebook/shared";
import { usePatchAuthProvider, useUploadAuthProviderIcon } from "@/api/adminAuth";
import { ProviderIcon } from "@/components/ProviderIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { authErrorMessage } from "./auth-error-message";
import { PROVIDER_ICON_ACCEPT, ProviderIconResizeError, resizeProviderIcon } from "./provider-icon-resize";

const CHOICES: ProviderIconKind[] = ["template", "gitlab", "google", "upload", "none"];
const GITLAB_ICON: ProviderIconDto = { type: "builtin", name: "gitlab" };
const GOOGLE_ICON: ProviderIconDto = { type: "builtin", name: "google" };

/**
 * 登入服務圖示對話框（spec 2026-10-07-provider-icon §6.3、D6）：五個選項各附預覽，按「儲存」才生效——上傳走 PUT、其他走 PATCH {iconKind}；
 * 無變更直接關（Q6）。表單型 → `dismissOnOutside={false}`。開或關都重設為目前的 iconKind（RF5）；縮圖的 `blob:` 在換掉或關閉時釋放。
 * 開或關都遞增 `generation`：關閉時還在跑的縮圖，回來後發現 generation 已變就丟掉結果（不建 `blob:`、不寫 state）——否則取消後再開會漏進舊檔。
 */
export function ProviderIconDialog({ provider }: { provider: AdminAuthProviderDto }) {
  const { t } = useTranslation();
  const patch = usePatchAuthProvider();
  const upload = useUploadAuthProviderIcon();
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ProviderIconKind>(provider.iconKind);
  const [picked, setPicked] = useState<{ blob: Blob; url: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `picked` 換掉（含設為 null）或卸載時釋放上一個 blob:（更新不會被 StrictMode 重跑，只有 mount 會——mount 時 picked 為 null）。
  useEffect(() => {
    if (picked === null) return;
    const url = picked.url;
    return () => URL.revokeObjectURL(url);
  }, [picked]);

  function handleOpenChange(next: boolean): void {
    generation.current += 1;
    setChoice(provider.iconKind);
    setPicked(null);
    setReading(false);
    setError(null);
    setOpen(next);
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = ""; // 同一個檔再選一次也要觸發 change
    if (file === undefined) return;
    setError(null);
    setPicked(null);
    setReading(true);
    const started = generation.current;
    try {
      const blob = await resizeProviderIcon(file);
      if (generation.current !== started) return; // 對話框已開關過：這張是被取消的那次選檔
      setPicked({ blob, url: URL.createObjectURL(blob) });
    } catch (err) {
      if (generation.current !== started) return;
      setError(t(`admin.auth.icon.${err instanceof ProviderIconResizeError ? err.reason : "unreadable"}`));
    } finally {
      if (generation.current === started) setReading(false);
    }
  }

  const busy = patch.isPending || upload.isPending;
  // Q6：選上傳、目前不是 upload、還沒有新檔 → 無從儲存。
  const needsFile = choice === "upload" && provider.iconKind !== "upload" && picked === null;

  async function handleSave(): Promise<void> {
    setError(null);
    try {
      if (choice === "upload" && picked !== null) {
        await upload.mutateAsync({ id: provider.id, file: picked.blob });
      } else if (choice !== "upload" && choice !== provider.iconKind) {
        await patch.mutateAsync({ id: provider.id, body: { iconKind: choice } });
      }
      // 其餘＝無變更（Q6）：不送請求，直接關。
      handleOpenChange(false);
    } catch (err) {
      setError(authErrorMessage(t, err));
    }
  }

  function preview(kind: ProviderIconKind): ProviderIconDto {
    switch (kind) {
      case "template":
        // template 分支不讀 version（spec §6.3）。
        return resolveProviderIcon({ id: provider.id, template: provider.template, iconKind: "template", iconVersion: 0 });
      case "gitlab":
        return GITLAB_ICON;
      case "google":
        return GOOGLE_ICON;
      case "upload":
        return picked !== null ? { type: "upload", url: picked.url } : provider.iconKind === "upload" ? provider.icon : null;
      case "none":
        return null;
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {t("admin.auth.icon.button")}
        </Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <DialogHeader>
          <DialogTitle>{t("admin.auth.icon.title")}</DialogTitle>
          <DialogDescription>{t("admin.auth.icon.description")}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={t("admin.auth.icon.title")} className="space-y-1">
          {CHOICES.map(kind => {
            const icon = preview(kind);
            return (
              <label key={kind} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60">
                <input type="radio" name={`provider-icon-${provider.id}`} checked={choice === kind} onChange={() => setChoice(kind)} disabled={busy} />
                {icon === null ? (
                  <span
                    aria-hidden="true"
                    className={kind === "upload" ? "h-4 w-4 shrink-0 rounded-sm border border-dashed border-border" : "h-4 w-4 shrink-0"}
                  />
                ) : (
                  <ProviderIcon icon={icon} />
                )}
                {t(`admin.auth.icon.options.${kind}`)}
              </label>
            );
          })}
        </div>
        {choice === "upload" && (
          <div className="space-y-1">
            <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={busy || reading}>
              {t("admin.auth.icon.choose")}
            </Button>
            <input ref={fileInput} type="file" accept={PROVIDER_ICON_ACCEPT} className="hidden" onChange={event => void handleFile(event)} />
            <p className="text-xs text-muted-foreground">{t("admin.auth.icon.uploadHint")}</p>
          </div>
        )}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("admin.auth.icon.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="brandDeep" onClick={() => void handleSave()} disabled={busy || reading || needsFile}>
            {busy ? t("admin.auth.icon.saving") : t("admin.auth.icon.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
