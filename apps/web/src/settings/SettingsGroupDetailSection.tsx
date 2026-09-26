import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { useGroups } from "@/api/groups";

/**
 * `/settings/groups/:id`（spec §8.4 後半）——**本 task 只放最小殼**：讀 `useGroups()`
 * 找出對應群組，找不到就是 `errors.not_found`（`GET /api/groups` 只列出呼叫者自己所屬的
 * 群組，故「不在清單裡」與「群組不存在／我已被移出」在這裡是同一種畫面）。Task 8 換掉
 * 整個 body（成員名單、改名、危險區）。
 */
export function SettingsGroupDetailSection() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const groupsQuery = useGroups();
  if (groupsQuery.isPending) return <p className="text-sm text-muted-foreground">{t("app.loading")}</p>;
  const group = groupsQuery.data?.find((candidate) => candidate.id === id);
  if (!group) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("errors.not_found")}
      </p>
    );
  }
  return <h1 className="text-xl font-semibold tracking-tight">{group.name}</h1>;
}
