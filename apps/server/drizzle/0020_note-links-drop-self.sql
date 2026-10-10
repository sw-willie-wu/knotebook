-- #240：JS 端的自身比對分大小寫，來源 id 與目標 id 大小寫不同時漏過自身過濾，落進 uuid 欄後正規化成相同值，留下 source = target 的自連結列；這裡刪掉它們。冪等。
DELETE FROM "note_links" WHERE "source_note_id" = "target_note_id";
