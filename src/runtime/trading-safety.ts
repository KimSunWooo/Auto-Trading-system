/**
 * Explicit safety authority for bootstrap vs account RuntimeScope.
 * Do not infer account readiness from process-global flags or any-lock.
 */
export type TradingSafetyContext = {
  /**
   * Account path: isScopeStartupSyncDone(brokerAccountId).
   * Bootstrap path: omit → processBootStartupVerified.
   */
  startupSyncVerified?: boolean;
  /**
   * Account path: scope.lockPath (file heartbeat is authoritative).
   * Bootstrap path: omit → holdsWorkerLock() legacy.
   */
  workerLockPath?: string;
  /**
   * When false, Worker must not place orders (RDS execution authority unread).
   * Omit on paths that do not consult RDS (unit tests / JSON mode).
   */
  executionAuthorityOk?: boolean;
  executionAuthorityBlockReason?: string;
};
