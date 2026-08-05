import * as argon2 from "argon2";

export class HashBusyError extends Error {
  constructor() {
    super("Hash operation busy: concurrency limit exceeded");
    this.name = "HashBusyError";
  }
}

// Pre-computed valid argon2id hash with parameters: m=19456, t=2, p=1
// Generated via: argon2.hash("dummy", { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
export const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$YnZ0eFZXVStHS3grQURiQQ$5T36ykcDZw9yRKP2HhS1RqhNcqQqxz/7EyqJQKr3bF4";

let maxConcurrency = 4;
let inFlight = 0;

// Design caveat: Concurrency limit is per-process; multi-instance deployment
// total memory = N instances × maxConcurrency × 19MiB (argon2id memory cost)

export function setHashConcurrency(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError("Concurrency must be a positive integer");
  }
  maxConcurrency = n;
}

async function withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= maxConcurrency) {
    throw new HashBusyError();
  }

  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return withSemaphore(() =>
    argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    })
  );
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return withSemaphore(async () => {
    try {
      return await argon2.verify(hash, password);
    } catch (err) {
      // Non-HashBusyError exceptions (e.g., invalid hash format) return false
      // instead of propagating to avoid 500 errors or existence oracles in Task 9
      if (err instanceof HashBusyError) {
        throw err;
      }
      return false;
    }
  });
}
