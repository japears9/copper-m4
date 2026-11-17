"use client";

// The Refund Console's state in the browser: the auto-refund limit, each
// order's status, and a decision log of who decided what. The console and
// the chat on the Support page share it, and it's saved in this browser
// (localStorage) so a refresh keeps it.
// When a person clicks Approve or Reject, listeners (the chat) hear about it,
// so the Refund agent can tell the customer.
import { useSyncExternalStore } from "react";
import {
  DEFAULT_REFUND_STATE,
  findOrder,
  type RefundState,
  type RefundStatus,
  statusOf,
} from "@/lib/copper/refunds";

const KEY = "copper-refunds-v2";
const LOG_KEY = "copper-refund-log-v1";
/** The log keeps the latest entries only. */
const LOG_SIZE = 50;

export type Decision = { orderId: string; decision: "approved" | "rejected" };

/**
 * One line in the decision log. `by` says who decided: the app's rule
 * (code), a person in the Refund Console, or a change to the settings.
 */
export type LogEntry = {
  id: number;
  /** ISO time it happened. */
  at: string;
  by: "code" | "person" | "setting";
  orderId?: string;
  text: string;
};

let state: RefundState = DEFAULT_REFUND_STATE;
let log: LogEntry[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const decisionListeners = new Set<(d: Decision) => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    if (
      saved &&
      typeof saved.limitUsd === "number" &&
      saved.limitUsd >= 0 &&
      typeof saved.statuses === "object"
    )
      state = { limitUsd: saved.limitUsd, statuses: { ...saved.statuses } };
  } catch {
    // Storage blocked or corrupt: start fresh.
  }
  try {
    const saved = JSON.parse(window.localStorage.getItem(LOG_KEY) ?? "[]");
    if (Array.isArray(saved)) log = saved.slice(-LOG_SIZE);
  } catch {
    // Start with an empty log.
  }
}

function save(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: everything still works until the page reloads.
  }
}

function set(next: RefundState) {
  state = next;
  save(KEY, state);
  listeners.forEach((listener) => listener());
}

function addLog(entry: Omit<LogEntry, "id" | "at">) {
  const id = (log.at(-1)?.id ?? 0) + 1;
  log = [...log, { ...entry, id, at: new Date().toISOString() }].slice(
    -LOG_SIZE,
  );
  save(LOG_KEY, log);
}

/** $149, $7.99: no ".00" on whole dollars. */
const usd = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;

export const refundStore = {
  get(): RefundState {
    load();
    return state;
  },
  /** The decision log, oldest first. */
  log(): LogEntry[] {
    load();
    return log;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setLimit(limitUsd: number) {
    const current = refundStore.get();
    if (!Number.isFinite(limitUsd) || limitUsd < 0) return;
    if (limitUsd === current.limitUsd) return;
    addLog({
      by: "setting",
      text: `Auto-refund limit changed from ${usd(current.limitUsd)} to ${usd(limitUsd)}`,
    });
    set({ ...current, limitUsd });
  },
  /** Records what the app's refund rule decided (from the Refund agent's tool). */
  apply(orderId: string, status: RefundStatus) {
    const current = refundStore.get();
    const order = findOrder(orderId);
    if (!order || statusOf(current, orderId) === status) return;
    const amount = usd(order.amountUsd);
    const limit = usd(current.limitUsd);
    if (status === "refunded")
      addLog({
        by: "code",
        orderId: order.id,
        text: `#${order.id} ${order.item}: ${amount} is within the ${limit} limit, so the app refunded it automatically`,
      });
    if (status === "waiting")
      addLog({
        by: "code",
        orderId: order.id,
        text: `#${order.id} ${order.item}: ${amount} is over the ${limit} limit, so the app held it for a person`,
      });
    set({ ...current, statuses: { ...current.statuses, [order.id]: status } });
  },
  /** A person's decision on a waiting refund. */
  decide(orderId: string, decision: Decision["decision"]) {
    const current = refundStore.get();
    const order = findOrder(orderId);
    if (!order || statusOf(current, order.id) !== "waiting") return;
    addLog({
      by: "person",
      orderId: order.id,
      text:
        decision === "approved"
          ? `#${order.id} ${order.item}: you approved the ${usd(order.amountUsd)} refund`
          : `#${order.id} ${order.item}: you rejected the refund, so ${usd(order.amountUsd)} stays with Copper`,
    });
    set({
      ...current,
      statuses: {
        ...current.statuses,
        [order.id]: decision === "approved" ? "refunded" : "rejected",
      },
    });
    decisionListeners.forEach((listener) =>
      listener({ orderId: order.id, decision }),
    );
  },
  /** Puts every order back to paid, the limit back to the default, and clears the log. */
  reset() {
    log = [];
    save(LOG_KEY, log);
    set(DEFAULT_REFUND_STATE);
  },
  onDecision(listener: (d: Decision) => void) {
    decisionListeners.add(listener);
    return () => {
      decisionListeners.delete(listener);
    };
  },
};

/** The current Refund Console state, re-rendering when it changes. */
export function useRefunds(): RefundState {
  return useSyncExternalStore(
    refundStore.subscribe,
    refundStore.get,
    () => DEFAULT_REFUND_STATE,
  );
}

const NO_LOG: LogEntry[] = [];

/** The decision log, re-rendering when it changes. */
export function useRefundLog(): LogEntry[] {
  return useSyncExternalStore(
    refundStore.subscribe,
    refundStore.log,
    () => NO_LOG,
  );
}
