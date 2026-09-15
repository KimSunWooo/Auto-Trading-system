import assert from "node:assert/strict";
import { test } from "node:test";
import { ruleDisplayName } from "./dashboard";

test("ruleDisplayName uses the saved rule title instead of the UUID", () => {
  const rules = [
    { id: "a9ddee64-d54e-4d47-a16f-af6712ec12a7", name: "안정형 · KODEX 200 적립", ticker: "069500" },
    { id: "cbce8612-138c-4f80-8240-a825e1a9259a", name: "중립형 · 삼성전자 이평 스윙", ticker: "005930" },
  ];
  assert.equal(
    ruleDisplayName(rules, "a9ddee64-d54e-4d47-a16f-af6712ec12a7"),
    "안정형 · KODEX 200 적립",
  );
  assert.equal(ruleDisplayName(rules, "cash"), "직접 매매");
  assert.equal(ruleDisplayName(rules, undefined), "직접 매매");
  assert.equal(ruleDisplayName(rules, "missing-id"), "삭제된 조건식");
});
