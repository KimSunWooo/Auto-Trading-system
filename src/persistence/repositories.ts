import type { Allocation, AppState, Order, OrderIntent, Position } from "@/lib/types";
import { findIntent, findOrderByIntent } from "@/src/runtime/intents";
import { sameOdno } from "@/src/brokers/kis-client";

/**
 * Persistence ports. Mock still uses JSON via JsonStateRepository.
 * SQLite/Postgres adapters can implement the same shapes later.
 */
export interface AccountRepository {
  cash(state: AppState): number;
  allocations(state: AppState): Allocation[];
}

export interface OrderRepository {
  all(state: AppState): Order[];
  byIntentId(state: AppState, intentId: string | undefined): Order | undefined;
  byBrokerOrderNo(state: AppState, odno: string | undefined): Order | undefined;
}

export interface ExecutionRepository {
  fills(state: AppState): Order[];
}

export interface PositionRepository {
  all(state: AppState): Position[];
}

export interface SignalRepository {
  all(state: AppState): OrderIntent[];
  byId(state: AppState, intentId: string | undefined): OrderIntent | undefined;
}

export const jsonAccountRepository: AccountRepository = {
  cash: (state) => state.cash,
  allocations: (state) => state.allocations,
};

export const jsonOrderRepository: OrderRepository = {
  all: (state) => state.orders,
  byIntentId: (state, intentId) => findOrderByIntent(state, intentId),
  byBrokerOrderNo: (state, odno) =>
    state.orders.find((row) => !row.parentOrderId && sameOdno(row.brokerOrderNo, odno)),
};

export const jsonExecutionRepository: ExecutionRepository = {
  fills: (state) => state.orders.filter((row) => row.status === "filled"),
};

export const jsonPositionRepository: PositionRepository = {
  all: (state) => state.positions,
};

export const jsonSignalRepository: SignalRepository = {
  all: (state) => state.intents ?? [],
  byId: (state, intentId) => findIntent(state, intentId),
};
