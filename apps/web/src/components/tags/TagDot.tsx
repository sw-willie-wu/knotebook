import type { TagColor } from "@knotebook/shared";
import { cn } from "@/lib/utils";

export function TagDot({ color, className }: { color: TagColor; className?: string }) {
  return <span aria-hidden="true" data-tag-color={color} className={cn("inline-block size-[7px] shrink-0 rounded-full bg-[var(--tag-dot)]", className)} />;
}
