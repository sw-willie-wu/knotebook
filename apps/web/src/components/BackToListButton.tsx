import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "@/components/ui/icons";
import { useIsPhone } from "@/lib/layout-tiers";
import { PhoneListContext } from "@/lib/phone-list";

/** 手機（< 640）筆記畫面頁首最左的「‹」：回清單。其餘寬度不渲染（那些寬度的入口是側欄鈕或固定側欄）。 */
export function BackToListButton() {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const phoneList = useContext(PhoneListContext);
  if (!phone) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t("note.backToList")}
      onClick={() => phoneList?.backToList()}
      // 視覺 32px，點擊範圍用 after 擴到 44px。
      className="relative h-8 w-8 shrink-0 after:absolute after:-inset-1.5 after:content-['']"
    >
      <ChevronLeft aria-hidden="true" className="h-5 w-5" />
    </Button>
  );
}
