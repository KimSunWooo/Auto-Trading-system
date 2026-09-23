/** Client-safe PAPER account verification types (no server imports). */
export type PaperAccountVerification = {
  brokerAccountId: string;
  environment: "PAPER";
  accountMasked: string;
  bindingVerified: boolean;
  fingerprintVerified: boolean;
  runtimeClientVerified: boolean;
  freshBrokerQuery: boolean;
  paginationComplete: boolean;
  pagesFetched: number;
  depositCash: number;
  orderableCash: number | null;
  holdings: Array<{
    ticker: string;
    name: string;
    qty: number;
    avgPrice: number;
  }>;
  localPositionsMatched: boolean;
  verifiedAt: string;
  readyForTrading: boolean;
  blockers: string[];
  fingerprintPrefix?: string;
  strategyAllocatedCash?: number;
};
