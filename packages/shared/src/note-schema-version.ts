/**
 * #269 §4.5：note schema 版本——舊分頁閘門（§5）的唯一比較對象。第一個受閘的版本是 1；collab token 沒帶視為 0。
 * schema（block／inline／style 的型別、prop 名、預設值）一改就要升這個數字，`note-schema-version.test.ts` 的 digest 守衛會逼你。
 * 比對用 `!==`（不是 `<`）：server 回滾、client 比 server 新同樣要重整。
 */
export const NOTE_SCHEMA_VERSION = 1;
