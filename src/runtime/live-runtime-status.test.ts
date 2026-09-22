import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLiveRdsHealthy,
  isMirrorDegraded,
} from "@/src/runtime/live-runtime-status";

test("isLiveRdsHealthy requires mirror+enabled+connected and no degraded", () => {
  assert.equal(isLiveRdsHealthy(null), false);
  assert.equal(isLiveRdsHealthy(undefined), false);
  assert.equal(
    isLiveRdsHealthy({
      mode: "mirror",
      enabled: true,
      connected: true,
      lastMirrorAt: null,
      lastError: null,
    }),
    true,
  );
  assert.equal(
    isLiveRdsHealthy({
      mode: "mirror",
      enabled: true,
      connected: false,
      lastMirrorAt: null,
      lastError: null,
    }),
    false,
  );
  assert.equal(
    isLiveRdsHealthy({
      mode: "json",
      enabled: false,
      connected: false,
      lastMirrorAt: null,
      lastError: null,
    }),
    false,
  );
  assert.equal(
    isLiveRdsHealthy({
      mode: "mirror",
      enabled: true,
      connected: true,
      lastMirrorAt: null,
      lastError: "DB_MIRROR_DEGRADED: x",
    }),
    false,
  );
  assert.equal(
    isMirrorDegraded({
      mode: "mirror",
      enabled: true,
      connected: true,
      lastMirrorAt: null,
      lastError: "DB_MIRROR_DEGRADED: x",
    }),
    true,
  );
});
