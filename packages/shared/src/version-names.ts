/**
 * #272 §10.2（D6'）：未命名版本的顯示名——由版本 uuid 推出的英文「形容詞-動物」（例 `plucky-finch`），不分語系、不存 DB
 * （`name` 仍是 null，「改名轉手動」規則不變）。取 uuid 最後一組（v4 的全隨機位元，`gen_random_uuid()`）的第 1–4、5–8 個 hex
 * 各 `% 64` 當索引；65536 可被 64 整除 → 均勻。同篇會撞名（4096 種組合）——辨識一律靠旁邊的短 id。
 * ⚠ 兩張字表一經發行即**凍結**：任何改動（含附加——索引是寫死的 `% 64`）都會讓既有版本換名；`version-names.test.ts` 釘住。
 * 字表是作者自擬的常見英文字（不取自第三方清單）；形容詞只用正面／中性字，名詞只用動物。
 * 本檔不 import 任何東西：e2e 以相對路徑直接 import（`e2e/tests/helpers.ts`）。
 */
export const VERSION_NAME_ADJECTIVES: readonly string[] = [
  "able", "agile", "amber", "ample", "azure", "bold", "brave", "bright",
  "brisk", "calm", "candid", "cheery", "civil", "clever", "cosmic", "crisp",
  "curious", "daring", "deft", "eager", "early", "earnest", "fair", "fancy",
  "fleet", "fond", "frank", "gentle", "glad", "golden", "grand", "happy",
  "hardy", "honest", "humble", "jolly", "keen", "kind", "lively", "loyal",
  "lucid", "merry", "mellow", "mighty", "modest", "noble", "plucky", "polite",
  "proud", "quick", "quiet", "rapid", "ready", "sharp", "shiny", "snowy",
  "steady", "sunny", "swift", "tidy", "upbeat", "vivid", "warm", "witty",
];

export const VERSION_NAME_NOUNS: readonly string[] = [
  "badger", "beaver", "bison", "bobcat", "crane", "cricket", "dolphin", "eagle",
  "falcon", "ferret", "finch", "fox", "gecko", "gibbon", "heron", "hare",
  "ibis", "jackal", "jaguar", "koala", "lemur", "leopard", "lynx", "magpie",
  "marten", "mole", "moose", "newt", "ocelot", "orca", "osprey", "otter",
  "owl", "panda", "parrot", "pelican", "penguin", "puffin", "quail", "rabbit",
  "raven", "robin", "salmon", "seal", "sparrow", "squid", "stork", "swan",
  "tapir", "tiger", "toucan", "trout", "turtle", "walrus", "weasel", "whale",
  "wombat", "wolf", "wren", "yak", "zebra", "bee", "crow", "deer",
];

const HEX32 = /^[0-9a-f]{32}$/;

/** uuid → 「形容詞-動物」；去掉連字號後不是 32 個 hex（防禦：測試用 id、壞資料）回 `"version"`。 */
export function derivedVersionName(id: string): string {
  const h = id.replace(/-/g, "").toLowerCase();
  if (!HEX32.test(h)) return "version";
  const adjective = VERSION_NAME_ADJECTIVES[parseInt(h.slice(20, 24), 16) % 64];
  const noun = VERSION_NAME_NOUNS[parseInt(h.slice(24, 28), 16) % 64];
  return `${adjective}-${noun}`;
}
