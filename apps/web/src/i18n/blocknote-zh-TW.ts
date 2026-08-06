import { zhTW } from "@blocknote/core/locales";
import type { Dictionary } from "@blocknote/core";

/**
 * BlockNote 編輯器 UI 的繁體中文字典（slash menu、placeholder、工具列…）。
 *
 * **刻意不自行翻譯**：`@blocknote/core@0.52` 已內建 `zh-tw` locale（`src/i18n/locales/
 * zh-tw.ts`，匯出名 `zhTW`），且該檔的型別就是 `Dictionary`——TypeScript 會強制它
 * 涵蓋 `en` 的每一把 key，不會有漏譯；內容也確實是繁體（實測全檔無簡體字，用詞為
 * 「影片／檔案／區塊」而非「视频／文件／块」），不是 zh-CN 轉碼。手抄一份 400+ 行的
 * 平行字典只會在 BlockNote 升版新增 key 時默默過期，因此這個模組只做「命名 + 單一
 * 匯入點」：頁面一律從這裡拿字典，日後若要覆寫個別詞條也只改這一個檔。
 *
 * 與 app 自身的 i18n（`src/i18n/{en,zh-TW}.json` + i18next）**是兩套**：這份只餵
 * `useCreateBlockNote({ dictionary })`，語言切換由 `NoteEditor` 依 i18next 當前語言
 * 挑 `en`／`zh-TW` 決定（BlockNote 的預設字典即英文，故英文那側不需要任何東西）。
 */
export const blocknoteZhTW: Dictionary = zhTW;
