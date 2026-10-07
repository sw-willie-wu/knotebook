/**
 * 對外連線（AI provider 的 fetch／Anthropic SDK、OIDC discovery）失敗時，log 只記這裡回的欄位——**不記 message**。
 *
 * 為什麼：provider 的 `base_url`／issuer 可能帶 `user:pass@`，Node 的 fetch 對這種網址直接丟
 * 「TypeError: Request cannot be constructed from a URL that includes credentials: <完整網址>」——message 裡就是明文密碼；
 * query 裡的憑證也可能出現在別種錯誤訊息裡。整個 err 交給 pino（含 stack、cause）就把它寫進 log。
 *
 * 取哪些：
 * - `errName`：錯誤名。Anthropic SDK 0.116 的 `APIConnectionError`／`APIConnectionTimeoutError`／`APIUserAbortError` 的 `.name`
 *   都是 "Error"，這時改取 `constructor.name` 才分得出是哪一種。
 * - `errCode`：錯誤本身的字串型 `code`（openid-client 的錯誤碼等）。
 * - `causeName`／`causeCode`：沿 `cause` 鏈往下最多 3 層——`causeName` 取第一層的名字，`causeCode` 取第一個字串型 `code`。
 *   undici 是「TypeError: fetch failed」→ cause 帶 `code`（ECONNREFUSED／ENOTFOUND）；Anthropic SDK 再多包一層
 *   （APIConnectionError → TypeError → 系統錯誤），所以 code 在 `cause.cause`。
 * 一律不取任何一層的 message。
 */
export interface FetchErrorSummary {
  errName: string;
  errCode?: string;
  causeName?: string;
  causeCode?: string;
}

const MAX_CAUSE_DEPTH = 3;

function nameOf(err: Error): string {
  return err.name === "Error" && err.constructor.name !== "" ? err.constructor.name : err.name;
}

export function fetchErrorSummary(err: unknown): FetchErrorSummary {
  if (!(err instanceof Error)) return { errName: typeof err };
  const summary: FetchErrorSummary = { errName: nameOf(err) };
  const ownCode = (err as { code?: unknown }).code;
  if (typeof ownCode === "string") summary.errCode = ownCode;

  let cause: unknown = err.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== null && typeof cause === "object"; depth += 1) {
    if (depth === 0) {
      const name = cause instanceof Error ? nameOf(cause) : (cause as { name?: unknown }).name;
      if (typeof name === "string") summary.causeName = name;
    }
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") {
      summary.causeCode = code;
      break;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return summary;
}

/**
 * 網址是否帶 userinfo（`user:pass@`）——上面那種 TypeError 的成因，不記 message 也查得出來。
 * 解析不出來回 undefined（pino 會略過該欄位）。
 */
export function urlHasCredentials(url: string): boolean | undefined {
  try {
    const parsed = new URL(url);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return undefined;
  }
}
