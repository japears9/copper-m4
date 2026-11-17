// Refunds (Module 4): the demo customer's orders and the refund rule.
// The rule lives here, in plain code: an order at or under the auto-refund
// limit is refunded on the spot; anything over it waits for a person in the
// Refund Console. The Refund agent can only ask; it can't change the answer.
// No server-only imports, so the Refund Console (a client component) shares it.
import { getPlans, getProducts } from "@/lib/copper/catalog";

/** Where an order stands. Every order starts "paid". */
export type RefundStatus = "paid" | "refunded" | "waiting" | "rejected";

export type Order = {
  id: string;
  item: string;
  /** The color or billing detail shown under the item. */
  detail: string;
  amountUsd: number;
  /** When it was bought, YYYY-MM-DD. */
  date: string;
};

/** What the Refund Console knows: the limit and each order's status. */
export type RefundState = {
  limitUsd: number;
  statuses: Record<string, RefundStatus>;
};

/** What refund_order tells the Refund agent. */
export type RefundResult =
  | "refunded"
  | "waiting_for_approval"
  | "already_refunded"
  | "already_waiting"
  | "already_rejected"
  | "not_found";

export type RefundOutcome = {
  result: RefundResult;
  orderId: string;
  item?: string;
  amountUsd?: number;
  /** The order's status after this request. */
  status?: RefundStatus;
};

/** The fictional customer chatting on the Support page. */
export const CUSTOMER = "Jordan Lee";

/** The starting auto-refund limit, in dollars. Change it in the Refund Console. */
export const DEFAULT_LIMIT_USD = 100;

const product = (id: string) => getProducts().find((p) => p.id === id)!;
const plus = getPlans().find((p) => p.id === "copper-plus")!;

/** Jordan's orders, priced from the catalog (Product Bible Sections 3 and 4). */
export const ORDERS: Order[] = [
  {
    id: "2041",
    item: `${plus.name}, monthly`,
    detail: "Subscription · billed Nov 3",
    amountUsd: plus.monthlyUsd,
    date: "2026-11-03",
  },
  {
    id: "2042",
    item: `${plus.name}, annual`,
    detail: "Subscription · billed Oct 21",
    amountUsd: plus.annualUsd,
    date: "2026-10-21",
  },
  {
    id: "2043",
    item: product("copper-notes").name,
    detail: "Desert Sand",
    amountUsd: product("copper-notes").priceUsd,
    date: "2026-10-30",
  },
  {
    id: "2044",
    item: product("copper-home").name,
    detail: "Patina Teal",
    amountUsd: product("copper-home").priceUsd,
    date: "2026-11-08",
  },
];

export const DEFAULT_REFUND_STATE: RefundState = {
  limitUsd: DEFAULT_LIMIT_USD,
  statuses: {},
};

/** "#2044", "order 2044" and "2044" all mean order 2044. */
export function normalizeOrderId(id: string): string {
  return id.replace(/[^0-9]/g, "");
}

export function findOrder(id: string): Order | undefined {
  const wanted = normalizeOrderId(id);
  return ORDERS.find((o) => o.id === wanted);
}

export function statusOf(state: RefundState, orderId: string): RefundStatus {
  return state.statuses[orderId] ?? "paid";
}

/**
 * The refund rule. Decides in code, never by the model:
 * already handled → say so; at or under the limit → refunded; over → waiting.
 */
export function decideRefund(
  state: RefundState,
  orderId: string,
): RefundOutcome {
  const order = findOrder(orderId);
  if (!order) return { result: "not_found", orderId };
  const base = {
    orderId: order.id,
    item: order.item,
    amountUsd: order.amountUsd,
  };
  const current = statusOf(state, order.id);
  if (current === "refunded")
    return { ...base, result: "already_refunded", status: current };
  if (current === "waiting")
    return { ...base, result: "already_waiting", status: current };
  if (current === "rejected")
    return { ...base, result: "already_rejected", status: current };
  return order.amountUsd <= state.limitUsd
    ? { ...base, result: "refunded", status: "refunded" }
    : { ...base, result: "waiting_for_approval", status: "waiting" };
}
