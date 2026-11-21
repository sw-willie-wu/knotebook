import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { ROW_ICON_HIT } from "@/components/ui/hit-area";
import { Library } from "@/components/ui/icons";
import { hoverReveal, type RevealScope } from "@/components/ui/reveal";
import { cn } from "@/lib/utils";

/** The row's way into the knowledge index of what it holds; rendered only for a scope that has knowledge. */
export function IndexButton({ to, name, reveal }: { to: string; name: string; reveal: RevealScope }) {
  const { t } = useTranslation();
  const label = t("sidebar.openIndex", { name });
  return (
    <Button asChild variant="ghost" size="icon" className={cn("h-6 w-6 shrink-0", ROW_ICON_HIT, hoverReveal(reveal))}>
      <Link to={to} aria-label={label} title={label}>
        <Library aria-hidden="true" className="h-3.5 w-3.5" />
      </Link>
    </Button>
  );
}
