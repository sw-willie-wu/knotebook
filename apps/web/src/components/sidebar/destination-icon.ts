import { ChevronLeft, Copy, CornerDownRight, Folder, House, Share, User, Users } from "@/components/ui/icons";
import type { DestItem } from "./destination-level";

/** 目的地項目前導圖示（選取模式的目的地框與筆記 ⋮ 的逐層子選單共用）：資料夾 `Folder`、空間依空間（個人 `User`、群組 `Users`、共享 `Share`）、建立副本 `Copy`；返回 `ChevronLeft`；根目錄（Top level）`House`；放進這裡（Move here／Copy here）`CornerDownRight`。目前每個 kind 都有圖示。 */
export function destinationItemIcon(item: DestItem): typeof Folder | null {
  if (item.kind === "back") return ChevronLeft;
  if (item.kind === "folder") return Folder;
  if (item.kind === "makeCopy") return Copy;
  if (item.kind === "root") return House;
  if (item.kind === "here") return CornerDownRight;
  if (item.kind !== "space" || item.target.kind !== "place") return null;
  const { space } = item.target;
  if (space.kind === "personal") return User;
  return space.kind === "group" ? Users : Share;
}
