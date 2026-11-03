import { describe, expect, it } from "vitest";
import {
  BULK_TRANSFER_INVALID_MESSAGE,
  BULK_TRANSFER_PAT_MESSAGE,
  BULK_TRANSFER_REQUIRED_MESSAGE,
  TRANSFER_INVALID_MESSAGE,
  TRANSFER_PAT_MESSAGE,
  TRANSFER_PURPOSE_MESSAGE,
} from "../../src/auth/transfer-auth.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../../src/folders/messages.js";
import {
  BASE_UNAVAILABLE_MESSAGE,
  EXPORT_BUSY_MESSAGE,
  INVALID_UTF8_MESSAGE,
  NOT_IN_RANGE_MESSAGE,
  NOT_MERGEABLE_MESSAGE,
  RANGE_GONE_MESSAGE,
  TOO_MANY_NOTES_MESSAGE,
  TRANSFER_NOTE_NOT_FOUND_MESSAGE,
  TRANSFER_RATE_LIMITED_MESSAGE,
} from "../../src/routes/transfer.js";
import {
  CREATE_IN_SHARED_FORBIDDEN_MESSAGE,
  DEST_NOT_IN_RANGE_MESSAGE,
  GROUP_CREATE_FORBIDDEN_MESSAGE,
  SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE,
} from "../../src/transfer/create-file.js";
import { UNCLOSED_FENCE_MESSAGE } from "../../src/transfer/regions.js";

/**
 * bulk transfer spec §12.2（HTTP 層中文、英文碼）；PR-3 plan T3、§0.1-5 守衛第一層：以**字面字串**釘住 bulk 端點的 HTTP 層與 auth 層
 * 中文常數（agent 經 curl 讀到的就是 JSON 的 `message`）。「哪條路由用哪個常數」由整合測試匯入常數比對（第二層，各案名帶常數名）。
 * 行內字面（不是常數）的句子——「沒有編輯權限」「此 token 沒有執行這個操作的權限」「伺服器忙碌中，請稍後再試」「請求過於頻繁，請稍後再試」
 * 「未登入」（bulk 端點收到非 Bearer 的 Authorization）「此請求需要 text/markdown」「Origin 驗證失敗」——在整合測試以字面斷言
 * （`transfer-write.test.ts` W9／W11、`transfer-bulk-auth.test.ts` A2／A12、
 * `transfer-write-auth.test.ts` W-A6／W-A7）；frontmatter 的八句在 `transfer-frontmatter-read.test.ts` 以字面斷言。
 * 413 `content_too_large` 沿用 Fastify 的英文 message（總管 2026-11-03：N16 暫不做），不在這裡。
 */
describe("bulk transfer 的 HTTP 層中文句（字面）", () => {
  it("H1 auth 層：bulk 專用句與 #200 句分開", () => {
    expect(BULK_TRANSFER_INVALID_MESSAGE).toBe("transfer token 無效、已過期或已撤銷；請透過 MCP 的 create_bulk_transfer_token 重新取得");
    expect(BULK_TRANSFER_INVALID_MESSAGE).not.toContain("已使用");
    expect(BULK_TRANSFER_REQUIRED_MESSAGE).toBe("需要 transfer token");
    expect(BULK_TRANSFER_PAT_MESSAGE).toBe("這個端點不收 API token；請透過 MCP 的 create_bulk_transfer_token 取得 transfer token");
    expect(TRANSFER_PURPOSE_MESSAGE).toBe("此 transfer token 不能用在這個動作");
    // #200 的兩句：本 PR 不動（W11）
    expect(TRANSFER_INVALID_MESSAGE).toBe("transfer token 無效、已過期或已使用");
    expect(TRANSFER_PAT_MESSAGE).toBe("這個端點不收 API token；請透過 MCP 的 create_transfer_token 取得 transfer token");
  });

  it("H2 路由層（routes/transfer.ts）", () => {
    expect(RANGE_GONE_MESSAGE).toBe("此 transfer token 的範圍已看不到");
    expect(NOT_IN_RANGE_MESSAGE).toBe("這篇筆記不在此 transfer token 的範圍內");
    expect(TRANSFER_NOTE_NOT_FOUND_MESSAGE).toBe("找不到此筆記");
    expect(TRANSFER_RATE_LIMITED_MESSAGE).toBe("請求過於頻繁，請稍後再試");
    expect(EXPORT_BUSY_MESSAGE).toBe("已有一個匯出正在進行，請稍後再試");
    expect(TOO_MANY_NOTES_MESSAGE).toBe("範圍內的筆記超過 3000 篇，請縮小範圍");
    expect(INVALID_UTF8_MESSAGE).toBe("檔案不是 UTF-8");
    expect(BASE_UNAVAILABLE_MESSAGE).toBe("無法以這份副本合併：已送回過不同的內容、不屬於這篇、已過期，或你改的某一處在筆記裡已經找不到該放的位置（例如它前後的內容被 edit_note 換掉）；請重新下載再改");
    expect(NOT_MERGEABLE_MESSAGE).toBe("這篇筆記不能用檔案寫回，請改用 edit_note");
  });

  it("H3 新增筆記的落點（transfer/create-file.ts＋借用的 folders/messages.ts）", () => {
    expect(CREATE_IN_SHARED_FORBIDDEN_MESSAGE).toBe("只含分享給你的筆記的 transfer token 不能新增筆記");
    expect(DEST_NOT_IN_RANGE_MESSAGE).toBe("新筆記的位置不在此 transfer token 的範圍內");
    expect(SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE).toBe("分享給你的資料夾不能放新筆記");
    expect(GROUP_CREATE_FORBIDDEN_MESSAGE).toBe("你在這個群組的角色不能建立筆記");
    expect(FOLDER_NOT_FOUND_MESSAGE).toBe("找不到此資料夾");
    expect(NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE).toBe("你在這個群組的角色不能把筆記放進資料夾");
  });

  it("H4 未閉合 code fence（transfer/regions.ts）", () => {
    expect(UNCLOSED_FENCE_MESSAGE).toBe(
      "你新增或改過的一行 ``` 開了程式碼區塊卻沒有收尾：從那一行起到檔尾都會被當成程式碼。請補上結尾的 ```（或改用行內 `code`）再送"
    );
  });
});
