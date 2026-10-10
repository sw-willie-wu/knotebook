/* eslint-disable @typescript-eslint/no-require-imports -- 在 e2e 疊的 app 容器內以 node 直接執行（CJS），不經 bundler */
// 寫一份「舊 schema 形」的 Y.Doc 進 note_states（spec §13-9 量測用）：heading 沒有 isToggleable、paragraph 沒有
// textAlignment／textColor／backgroundColor；numberedListItem 只有文字（沒有 start 與三個預設屬性）；image 只有 url
// （沒有 previewWidth／showPreview／caption／name 等；image 是 content:"none"，元素底下沒有文字節點——形狀照
// BlockNote 0.52 `blocksToYXmlFragment` 實印）。只給 e2e 23 用；不是產品碼。
const Y = require("yjs");
const { Client } = require("pg");

const noteId = process.env.NOTE_ID;
if (!noteId) throw new Error("NOTE_ID required");
const imageUrl = process.env.IMAGE_URL;
if (!imageUrl) throw new Error("IMAGE_URL required");

const doc = new Y.Doc();
const frag = doc.getXmlFragment("knotebook");
const group = new Y.XmlElement("blockGroup");
const mk = (id, type, attrs, text) => {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", id);
  const node = new Y.XmlElement(type);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) {
    const t = new Y.XmlText();
    t.insert(0, text);
    node.insert(0, [t]);
  }
  container.insert(0, [node]);
  return container;
};
group.insert(0, [
  mk("legacy-h", "heading", { level: 2 }, "Legacy heading"),
  mk("legacy-p", "paragraph", {}, "Legacy paragraph"),
  mk("legacy-n", "numberedListItem", {}, "Legacy numbered"),
  mk("legacy-i", "image", { url: imageUrl }),
]);
frag.insert(0, [group]);
const bytes = Buffer.from(Y.encodeStateAsUpdate(doc));

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO note_states (note_id, ydoc, version, updated_at) VALUES ($1, $2, 1, now())
     ON CONFLICT (note_id) DO UPDATE SET ydoc = EXCLUDED.ydoc, version = note_states.version + 1, updated_at = now()`,
    [noteId, bytes],
  );
  await client.end();
  console.log(`seeded ${noteId} bytes=${bytes.length}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
