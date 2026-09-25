export {
  FakeBroker,
  fakeBrokerMode,
  type FakeBrokerMode,
  /** @deprecated Prefer FakeBroker */
  MockBroker,
} from "@/src/test-support/fake-broker";
export {
  makeTestQuote,
  makeTestPaperState,
  advanceTestQuotes,
  TEST_PAPER_DEPOSIT,
  type TestQuoteSource,
} from "@/src/test-support/quote-fixtures";
