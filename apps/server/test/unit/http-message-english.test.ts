/**
 * #372 守衛：HTTP 回應的 `message`（`sendError`、`TxAbort`、`sendOauthError` 的 `error_description`、路由行內
 * `reply.send({ error: { message } })`、zod `.refine` 訊息、`*_MESSAGE` 常數……）一律英文。
 *
 * 做法是**反向**掃描：把 `src/` 每個 .ts 檔切 token（剝註解、認得字串／template／regex 字面），找出所有含 CJK 的字串字面，
 * 每一個都必須命中下面的**排除規則**之一，否則紅。這樣新加的任何回應形狀（新 helper、新常數名）都會被掃到，
 * 只有明確列為「不會進 HTTP 回應」的位置才放行。排除規則（範圍盡量窄，新增前先確認那句真的不會回到 HTTP）：
 *
 *   R1 log：字面**最內層**的呼叫是 pino——callee 為 `log.<level>(`、`log?.<level>(`、`logger.<level>(`（含 `request.log.warn(`、
 *      `deps.log?.warn(` 這類鏈），level ∈ trace／debug／info／warn／error／fatal。另 `notes/version-fingerprint.ts` 的
 *      注入式 `warn(`（參數名就叫 warn，同一顆 pino 方法）。只看最內層：log 引數裡巢狀的 `sendError(…, "中文")` 照樣紅。
 *   R2 只進 log 的例外：字面最內層的呼叫是 `new Error(`／`new RangeError(`／`new TypeError(`、`new AiKeyDecryptError(`、
 *      `new OidcUnavailableError(`、`new SecretDecryptError(` 或 `redactDbError(`，**且**這個例外不是另一個呼叫的直接引數
 *      （`throw …`、`return …` 才放行；`sendError(…, redactDbError(…, "中文").message)` 紅）。
 *      ⚠ `TxAbort` **不在**此列——它的 message 就是 HTTP 回應。
 *   R3 log 用的具名常數：頂層 `const <NAME>_LOG = "…"`（名字以 `_LOG` 結尾＝只給 log 用）。頂層 `const` 的範圍到 `;` 或下一個
 *      頂層宣告關鍵字（function／export／class／async／let／var／import／interface／type）為止，漏寫分號也不會延伸。
 *   R4 啟動期設定：`config.ts` 整檔（env 解析與啟動警告，在 listen 之前，不經任何路由）。
 *   R5 逐條列名的例外（檔＋頂層常數名，或檔＋字面）：資料名稱與 `/oauth/authorize` 的雙語說明頁，見 `NAMED`。
 *
 * 誠實：字面掃描——字串由程式組出來（拼接非 CJK 片段再轉碼之類）或從 src 以外的地方（shared 套件）流進回應的守不到；
 * 行為面由各路由的整合測試逐字比對 message。各規則的前提也只是約定，守衛本身不驗：
 *   - R2 的前提是**例外的 message 不會原文回給客戶端**：未接住的例外進全域 errorHandler，status ≥ 500 回 "Internal server error."；
 *     三個具名例外由路由接住後回固定英文句。但 `app.ts` 的 errorHandler 對 status < 500 的錯誤會原樣送出 `error.message`
 *     （為了 fastify 內建的 4xx），所以若有人 `new Error("中文")` 再設 `statusCode = 400` 丟出去，那句會漏到回應裡、守衛抓不到
 *     （目前 src 沒有這種寫法）。
 *   - R3 的前提是 `*_LOG` 常數只傳給 log；拿它當 `sendError` 的 message 守衛分不出來。
 *   - regex 與除號用前一個 token 粗判；`if (x) /re/` 這類罕見寫法可能切錯 token。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
/** CJK 標點、統一漢字（含擴充 A）、相容漢字、全形字元；另認 `\uXXXX` 跳脫寫成的同範圍字（字面原文裡的跳脫序列）。 */
const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]|\\u(?:3[0-9a-fA-F]{3}|[4-9][0-9a-fA-F]{3}|[fF][9aA][0-9a-fA-F]{2}|[fF]{2}[0-9a-eA-E][0-9a-fA-F])/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

interface CjkLiteral {
  line: number;
  text: string;
  /** 由外到內，每一層未閉合的 `(` 前面的 callee（`new X` 記成 `new X`）；`[`／`{` 記成 null。 */
  callees: (string | null)[];
  /** 字面位於頂層 `const NAME = …;` 的初始值裡（任意深度）時的 NAME。 */
  topConst: string | null;
}

/** 深度 0 出現就代表上一個頂層 `const` 宣告已結束的關鍵字。 */
const STATEMENT_START = new Set(["function", "export", "class", "async", "let", "var", "import", "interface", "type"]);

/** 前一個有意義字元能不能接 regex 字面（否則 `/` 是除號）。 */
function regexAllowedAfter(prev: string, word: string): boolean {
  if (prev === "") return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(prev)) return true;
  return ["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new"].includes(word);
}

function scanCjkLiterals(src: string): CjkLiteral[] {
  const out: CjkLiteral[] = [];
  const stack: (string | null)[] = [];
  let i = 0;
  let line = 1;
  let prev = ""; // 前一個有意義（非空白、非註解）字元
  let prevWord = ""; // 前一個識別字
  let topConst: string | null = null;

  const calleeBefore = (pos: number): string | null => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(src[j]!)) j--;
    let k = j;
    while (k >= 0 && /[\w$.?]/.test(src[k]!)) k--;
    const name = src.slice(k + 1, j + 1);
    if (name === "" || !/[\w$]/.test(name)) return null;
    let m = k;
    while (m >= 0 && /\s/.test(src[m]!)) m--;
    const isNew = m >= 2 && src.slice(m - 2, m + 1) === "new" && (m < 3 || !/[\w$]/.test(src[m - 3]!));
    return isNew ? `new ${name}` : name;
  };

  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      const j = src.indexOf("\n", i);
      i = j < 0 ? src.length : j;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? src.length : j + 2;
      line += (src.slice(i, end).match(/\n/g) ?? []).length;
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const startLine = line;
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        const d = src[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") line++;
        if (c === "`" && src.startsWith("${", j)) {
          depth++;
          j += 2;
          continue;
        }
        if (c === "`" && depth > 0 && d === "{") {
          depth++;
          j++;
          continue;
        }
        if (c === "`" && depth > 0 && d === "}") {
          depth--;
          j++;
          continue;
        }
        if (d === c && depth === 0) break;
        j++;
      }
      const text = src.slice(i, j + 1);
      if (CJK.test(text)) out.push({ line: startLine, text, callees: [...stack], topConst });
      i = j + 1;
      prev = c;
      prevWord = "";
      continue;
    }
    if (c === "/" && regexAllowedAfter(prev, prevWord)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        const d = src[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/.test(src[j]!)) j++;
      i = j;
      prev = "/";
      prevWord = "";
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      if (stack.length === 0 && word === "const") {
        const m = /^const\s+([\w$]+)\s*(?::[^=]+)?=/.exec(src.slice(i));
        topConst = m ? m[1]! : null;
      } else if (stack.length === 0 && STATEMENT_START.has(word)) {
        // 漏寫分號時，下一個頂層宣告不能繼承上一個 const 的名字（否則 `const X_LOG = "…"` 之後整段都被當成 R3）。
        topConst = null;
      }
      prevWord = word;
      prev = word[word.length - 1]!;
      i = j;
      continue;
    }
    if (c === "(") stack.push(calleeBefore(i));
    else if (c === "[" || c === "{") stack.push(null);
    else if (c === ")" || c === "]" || c === "}") stack.pop();
    else if (c === ";" && stack.length === 0) topConst = null;
    prev = c;
    prevWord = "";
    i++;
  }
  return out;
}

const LOG_CALLEE = /(^|\.)(log|logger)\??\.(trace|debug|info|warn|error|fatal)$/;
const EXCEPTION_CALLEE = new Set([
  "new Error",
  "new RangeError",
  "new TypeError",
  "new AiKeyDecryptError",
  "new OidcUnavailableError",
  "new SecretDecryptError",
  "redactDbError",
]);
/** R1 的檔案限定 callee：注入式的 pino 方法。 */
const FILE_LOG_CALLEES: Record<string, string[]> = { "notes/version-fingerprint.ts": ["warn"] };
/** R4：整檔排除。 */
const EXCLUDED_FILES = new Set(["config.ts"]);
/** R5：逐條列名。`const` 是頂層常數名；`literal` 是字面原文（含引號）。 */
const NAMED: { file: string; const?: string; literal?: string; why: string }[] = [
  { file: "notes/link-conversion.ts", const: "LINK_CONVERSION_VERSION_NAME", why: "資料：一次性連結轉換前自動存的版本名稱" },
  { file: "folders/names.ts", literal: '"群組"', why: "資料：刪群組轉移時新資料夾的預設名稱（依瀏覽器語言）" },
  { file: "routes/oauth.ts", const: "UNKNOWN_CLIENT_MESSAGE", why: "/oauth/authorize 給人看的純文字頁，刻意中英雙語（不是 message 欄位）" },
  { file: "routes/oauth.ts", const: "T1_MESSAGE", why: "同上" },
  { file: "routes/oauth.ts", const: "RATE_LIMITED_MESSAGE", why: "同上" },
];

function excludedBy(file: string, lit: CjkLiteral): string | null {
  if (EXCLUDED_FILES.has(file)) return "R4";
  // R1／R2 只看**最內層**的非 null callee：`log.warn({ sent: sendError(…, "中文") })` 的字面屬於 sendError，不是 log。
  let at = lit.callees.length - 1;
  while (at >= 0 && lit.callees[at] === null) at--;
  const inner = at >= 0 ? lit.callees[at]! : null;
  if (inner !== null && (LOG_CALLEE.test(inner) || (FILE_LOG_CALLEES[file] ?? []).includes(inner))) return "R1";
  // R2 另要求例外本身不是某個呼叫的直接引數：`sendError(…, redactDbError(…, "中文").message)` 的值流進了回應。
  if (inner !== null && EXCEPTION_CALLEE.has(inner) && (at === 0 || lit.callees[at - 1] === null)) return "R2";
  if (lit.topConst !== null && lit.topConst.endsWith("_LOG")) return "R3";
  if (NAMED.some(n => n.file === file && ((n.const !== undefined && n.const === lit.topConst) || (n.literal !== undefined && n.literal === lit.text)))) return "R5";
  return null;
}

function offenders(files: { file: string; src: string }[]): string[] {
  return files.flatMap(({ file, src }) =>
    scanCjkLiterals(src)
      .filter(lit => excludedBy(file, lit) === null)
      .map(lit => `${file}:${lit.line} ${lit.text.slice(0, 80)}`)
  );
}

const ALL = walk(SRC).map(p => ({ file: rel(p), src: readFileSync(p, "utf8") }));

describe("#372 HTTP 回應訊息一律英文", () => {
  it("src/ 沒有未排除的含 CJK 字串字面", () => {
    expect(offenders(ALL)).toEqual([]);
  });

  it("非空洞：確實掃到了被排除的中文字面（各規則都有命中）", () => {
    const hit = new Set<string>();
    for (const { file, src } of ALL) for (const lit of scanCjkLiterals(src)) hit.add(excludedBy(file, lit) ?? "none");
    for (const r of ["R1", "R2", "R3", "R4", "R5"]) expect(hit.has(r), r).toBe(true);
  });

  it("R5 每一條列名都還找得到對應字面（過時的例外要刪）", () => {
    for (const n of NAMED) {
      const f = ALL.find(x => x.file === n.file);
      expect(f, n.file).toBeDefined();
      const lits = scanCjkLiterals(f!.src);
      expect(lits.some(l => (n.const !== undefined && l.topConst === n.const) || (n.literal !== undefined && l.text === n.literal)), JSON.stringify(n)).toBe(true);
    }
  });

  it.each([
    ["sendError", 'sendError(reply, 404, "not_found", "找不到");'],
    ["TxAbort", 'throw new TxAbort(409, "conflict", "衝突");'],
    ["sendOauthError", 'return sendOauthError(reply, 400, "invalid_request", "格式錯");'],
    ["行內 reply.send", 'return reply.code(409).send({ error: { code: "stale", message: "過期" }, current });'],
    ["zod refine", 'const s = z.string().refine(v => v.length > 0, "不得為空");'],
    ["template", "const M = `最多 ${N} 層`;"],
    ["*_MESSAGE 常數", 'export const X_MESSAGE = "訊息";'],
    ["log 呼叫旁同一行的 sendError", 'request.log.warn({}, "ok"); return sendError(reply, 400, "invalid_body", "錯");'],
    ["log 引數裡巢狀的 sendError", 'request.log.warn({ sent: sendError(reply, 400, "invalid_body", "錯") });'],
    ["redactDbError 的 message 流進 sendError", 'return sendError(reply, 500, "internal", redactDbError(request.log, err, "建立").message);'],
    ["new Error 的 message 流進 sendError", 'return sendError(reply, 400, "invalid_body", new Error("錯").message);'],
    ["_LOG 常數漏寫分號，下一個頂層 function 的 sendError", 'const AUDIT_LOG = "ok"\nexport function f(reply) { return sendError(reply, 400, "invalid_body", "錯"); }'],
    ["_LOG 常數漏寫分號，下一個頂層 async／let", 'const AUDIT_LOG = "ok"\nlet m = "錯"'],
    ["\\u 跳脫寫的中文", 'sendError(reply, 404, "not_found", "\\u627e\\u4e0d\\u5230");'],
    ["相容漢字", 'sendError(reply, 404, "not_found", "豈");'],
  ])("形狀 %s 帶中文 → 被抓到", (_name, snippet) => {
    expect(offenders([{ file: "routes/x.ts", src: snippet }])).toHaveLength(1);
  });

  it("R5 列名常數漏寫分號，後面頂層 function 的中文 sendError 照樣紅（只放行常數本身）", () => {
    const src = 'const T1_MESSAGE =\n  "雙語說明"\nfunction f(reply) { return sendError(reply, 400, "invalid_body", "錯"); }';
    expect(offenders([{ file: "routes/oauth.ts", src }])).toEqual(['routes/oauth.ts:3 "錯"']);
  });

  it.each([
    ["pino log", 'request.log.warn({ err }, "記錄");'],
    ["pino log 多行", 'deps.log?.error(\n  { noteId },\n  "多行記錄"\n);'],
    ["new Error", 'throw new Error(`不變量被打破：${x}`);'],
    ["redactDbError", 'throw redactDbError(request.log, err, "建立");'],
    ["_LOG 常數", 'const AUDIT_LOG = "稽核";'],
    ["註解", '// 中文註解\n/* 區塊 註解 */ sendError(reply, 400, "invalid_body", "Invalid request body.");'],
    ["regex 字面裡的引號不吃掉後面", 'const re = /["\']/; log.info("記錄");'],
  ])("排除 %s → 不紅", (_name, snippet) => {
    expect(offenders([{ file: "routes/x.ts", src: snippet }])).toEqual([]);
  });
});
