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
};
