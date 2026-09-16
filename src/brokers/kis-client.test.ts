import assert from "node:assert/strict";
import test from "node:test";
import { KisClient, resetKisTokenCacheForTest } from "./kis-client";
import { getKisConfig, KIS_HOSTS, KIS_LIVE_CONFIRM_VALUE } from "./kis-config";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response;
}

test("paper and real access tokens are cached under separate keys", async () => {
  resetKisTokenCacheForTest();
  const tokenHosts: string[] = [];
  const appKeys: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.appkey) appKeys.push(headers.appkey);
    if (url.includes("tokenP")) {
      tokenHosts.push(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as { appkey?: string };
      if (body.appkey) appKeys.push(body.appkey);
      return jsonResponse({
        access_token: body.appkey === "paper-key" ? "paper-token-value" : "real-token-value",
        expires_in: 86_400,
      });
    }
    return jsonResponse({
      rt_cd: "0",
      output: {
        stck_prpr: "70000",
        hts_kor_isnm: "삼성전자",
        stck_oprc: "70000",
        stck_hgpr: "71000",
        stck_lwpr: "69000",
        stck_sdpr: "69500",
        acml_vol: "1",
      },
    });
  }) as typeof fetch;

  const paper = new KisClient(
    getKisConfig("paper", {
      KIS_PAPER_APP_KEY: "paper-key",
      KIS_PAPER_APP_SECRET: "paper-secret",
      KIS_PAPER_ACCOUNT_NO: "11111111-01",
    }),
    fetchImpl,
  );
  const real = new KisClient(
    getKisConfig("real", {
      KIS_REAL_APP_KEY: "real-key",
      KIS_REAL_APP_SECRET: "real-secret",
      KIS_REAL_ACCOUNT_NO: "22222222-01",
      KIS_LIVE_CONFIRM: KIS_LIVE_CONFIRM_VALUE,
      TRADING_MODE: "live",
      ALLOW_LIVE_TRADING: "true",
    }),
    fetchImpl,
  );

  await paper.inquirePrice("005930");
  await real.inquirePrice("005930");

  assert.equal(paper.tokenCacheKey, "kis:token:paper");
  assert.equal(real.tokenCacheKey, "kis:token:real");
  assert.ok(tokenHosts.some((url) => url.startsWith(KIS_HOSTS.paper)));
  assert.ok(tokenHosts.some((url) => url.startsWith(KIS_HOSTS.real)));
  assert.ok(appKeys.includes("paper-key"));
  assert.ok(appKeys.includes("real-key"));
  assert.equal(
    appKeys.includes("paper-key") && appKeys.includes("real-key"),
    true,
  );
});
