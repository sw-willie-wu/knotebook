import { cn } from "@/lib/utils";

export const chipClass = (active: boolean): string =>
  cn(
    "inline-flex h-7 items-center gap-1 rounded-full border border-input bg-background px-2.5 text-xs outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-9",
    active && "border-brand/60 bg-accent",
  );
