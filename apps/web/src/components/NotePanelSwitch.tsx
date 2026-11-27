import { useTranslation } from "react-i18next";
import { useComments } from "@/lib/comments-context";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";

let switching = false;

export function NotePanelSwitch({ current }: { current: "comments" | "versions" }) {
  const { t } = useTranslation();
  const versions = useVersions();
  const comments = useComments();
  if (!versions.enabled || !comments.enabled) return null;
  const item = (which: "comments" | "versions", label: string, open: () => void) => (
    <button
      type="button"
      aria-pressed={current === which}
      onClick={() => {
        if (current === which) return;
        switching = true;
        open();
      }}
      className={cn(
        "h-10 flex-1 rounded-md px-2 text-sm text-muted-foreground",
        current === which ? "bg-card font-medium text-foreground shadow-sm" : "hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={t("note.cornerToggle")} data-testid="note-panel-switch" className="mx-3 mt-2 flex gap-1 rounded-lg bg-muted p-1">
      {item("comments", t("note.menu.comments"), () => comments.open())}
      {item("versions", t("versions.title"), versions.open)}
    </div>
  );
}

/**
 * For a sheet's `onCloseAutoFocus`: true once after a switch, when focus belongs to the sheet that replaces it. That sheet may still be
 * loading its chunk when Radix runs this, so the DOM can't tell.
 */
export function consumeNotePanelSwitch(): boolean {
  const was = switching;
  switching = false;
  return was;
}
