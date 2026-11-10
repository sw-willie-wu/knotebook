-- bulk transfer（探索測試 C）：transfer_bases 加 applied_edit_ids（寫回這份檔時記下的 note_ai_edits 列 id）。同檔重送時其中任一列已撤回 → 409 base_unavailable（reason reverted），不再回 unchanged。只加可 NULL 欄、不回填（舊列＝NULL＝沒有紀錄可查，照「沒撤回」處理）；回滾到前一版：舊碼不讀這欄。
ALTER TABLE "transfer_bases" ADD COLUMN "applied_edit_ids" uuid[];
