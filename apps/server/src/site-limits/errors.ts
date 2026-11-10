/** #397 §6.1／§11：`SiteLimits.update` 的驗證錯誤；路由對應成 HTTP（§8.2）。訊息一律英文（#372）。 */
import { siteLimitDef, siteLimitStep, type SiteLimitKey } from "@knotebook/shared";

/** → 409 limit_locked_by_env */
export class LimitLockedError extends Error {
  constructor(readonly key: SiteLimitKey, readonly env: string) {
    super(`${key} is set by the server's environment variable ${env}. Change it there and restart the server.`);
    this.name = "LimitLockedError";
  }
}

/** → 400 invalid_body */
export class LimitRangeError extends Error {
  readonly min: number;
  readonly max: number;
  constructor(readonly key: SiteLimitKey) {
    const { min, max } = siteLimitDef(key);
    super(`${key} must be a whole number from ${min} to ${max}.`);
    this.name = "LimitRangeError";
    this.min = min;
    this.max = max;
  }
}

/** → 400 invalid_body（step 用 API 單位） */
export class LimitStepError extends Error {
  readonly step: number;
  constructor(readonly key: SiteLimitKey) {
    const step = siteLimitStep(key);
    super(`${key} must be a multiple of ${step}.`);
    this.name = "LimitStepError";
    this.step = step;
  }
}
