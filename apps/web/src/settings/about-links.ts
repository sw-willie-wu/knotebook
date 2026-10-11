/**
 * 關於頁的連結（#247 §5.6）。根目錄與 apps/web 的 package.json 都沒有 `repository` 欄位，
 * 所以 repo 網址寫成常數（取自 `git remote get-url origin`）；文件與授權條款由它組出。
 */
export const REPO_URL = "https://github.com/sw-willie-wu/knotebook";
export const DOCS_URL = `${REPO_URL}/tree/main/docs`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
