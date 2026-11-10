/** Mirrors Python ats_research.result_events */
export const BACKTEST_RESULTS_TOPIC = "backtest-results";
export const BACKTEST_RESULT_SCHEMA = "backtest-result.v1";
export const RESULT_CONSUMER_GROUP = "ext-backtest-results-v1";

export type BacktestResultEvent = {
  eventId: string;
  jobId: string;
  schemaVersion: string;
  status: "SUCCEEDED" | "FAILED" | string;
  completedAtUnixMs: number;
  partitionKey: string;
};

export function parseResultEvent(raw: string | Buffer): BacktestResultEvent {
  const obj = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as BacktestResultEvent;
  if (!obj.eventId || !obj.jobId) {
    throw new Error("invalid_backtest_result_event");
  }
  return obj;
}
