import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 慣例：合併 className，clsx 處理條件式、tailwind-merge 消解衝突的 Tailwind class。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
