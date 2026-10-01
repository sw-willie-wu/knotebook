/**
 * #175 S14：交易本體（`*InTx`）的參數型別只從這裡取。**本檔只含型別**——`import type { Db }` 在執行期
 * 會被抹掉，`*InTx` 檔 `import type { Tx } from "../../db/tx.js"` 就碰不到 pool，錯的寫法（交易內
 * 再向 pool 借連線）寫不出來（spec §4.4 S14）。原本在 `groups/queries.ts` 的 `Tx`／`DbOrTx` 搬到這裡。
 */
import type { Db } from "./index.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;
