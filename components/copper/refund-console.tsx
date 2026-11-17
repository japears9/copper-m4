"use client";

// The Refund Console (Module 4). Built around one question: who decides?
// - The rule card shows the decision the app's code makes (at or under the
//   limit: refunded automatically) and the one a person makes (over it).
// - The review queue holds refunds waiting for a person: Approve or Reject
//   here is the only way one can go through.
// - The decision log records every decision, stamped CODE, PERSON or SETTING.
import {
  BotIcon,
  CheckIcon,
  Code2Icon,
  HandIcon,
  HistoryIcon,
  InboxIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  UserCheckIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type LogEntry,
  refundStore,
  useRefundLog,
  useRefunds,
} from "@/components/copper/refund-store";
import { formatUsd } from "@/lib/copper/catalog";
import {
  CUSTOMER,
  ORDERS,
  type RefundStatus,
  statusOf,
} from "@/lib/copper/refunds";
import { cn } from "@/lib/utils";

const money = formatUsd;

/** Quick picks for the limit, including $0 (everything needs a person). */
const PRESETS = [0, 50, 100, 150];

const STATUS: Record<RefundStatus, { label: string; className: string }> = {
  paid: { label: "Paid", className: "bg-muted text-muted-foreground" },
  refunded: { label: "Refunded", className: "bg-accent text-white" },
  waiting: { label: "Needs review", className: "bg-chart-4 text-chart-5" },
  rejected: {
    label: "Refund rejected",
    className: "bg-destructive/15 text-destructive",
  },
};

const WHO: Record<
  LogEntry["by"],
  { label: string; className: string; icon: ReactNode }
> = {
  code: {
    label: "Code",
    className: "bg-chart-5 text-white dark:bg-white dark:text-chart-5",
    icon: <Code2Icon className="size-3" />,
  },
  person: {
    label: "Person",
    className: "bg-primary text-primary-foreground",
    icon: <UserCheckIcon className="size-3" />,
  },
  setting: {
    label: "Setting",
    className: "bg-muted text-muted-foreground",
    icon: <SlidersHorizontalIcon className="size-3" />,
  },
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

export function RefundConsole() {
  const refunds = useRefunds();
  const log = useRefundLog();
  const waiting = ORDERS.filter((o) => statusOf(refunds, o.id) === "waiting");
  const total = (status: RefundStatus) =>
    ORDERS.filter((o) => statusOf(refunds, o.id) === status).reduce(
      (sum, o) => sum + o.amountUsd,
      0,
    );
  // Who settled each order, from the latest log line about it.
  const decidedBy = (orderId: string) =>
    [...log].reverse().find((e) => e.orderId === orderId)?.by;

  function saveLimit(value: string) {
    const limit = Number(value);
    if (value.trim() !== "" && Number.isFinite(limit) && limit >= 0)
      refundStore.setLimit(Math.round(limit * 100) / 100);
  }

  return (
    <div className="mt-2 space-y-6">
      <p className="text-muted-foreground">
        You&apos;re reviewing refunds for{" "}
        <span className="text-foreground font-semibold">{CUSTOMER}</span>. Ask
        for one in the chat as the customer: Copper hands it to the Refund
        agent, the app&apos;s code applies your limit, and anything over it
        lands in your review queue.
      </p>

      {/* The rule: what code decides, and what you decide. */}
      <section
        data-testid="refund-rule"
        className="bg-card overflow-hidden rounded-2xl border"
      >
        <div className="grid sm:grid-cols-2">
          <div className="space-y-2 p-4">
            <Badge who="code" />
            <p className="font-semibold">
              Order {money(refunds.limitUsd)} or less
            </p>
            <p className="text-muted-foreground text-sm">
              Refunded automatically the moment the Refund agent asks. No one
              needs to look.
            </p>
          </div>
          <div className="bg-secondary/60 space-y-2 border-t p-4 sm:border-t-0 sm:border-l">
            <Badge who="person" />
            <p className="font-semibold">Over {money(refunds.limitUsd)}</p>
            <p className="text-muted-foreground text-sm">
              Held in your review queue. Nothing is refunded until you approve
              it.
            </p>
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem("limit");
            if (input instanceof HTMLInputElement) saveLimit(input.value);
          }}
          className="flex flex-wrap items-end gap-x-4 gap-y-3 border-t border-dashed p-4"
        >
          <div className="space-y-1.5">
            <label
              htmlFor="refund-limit"
              className="text-muted-foreground block text-xs font-semibold tracking-widest uppercase"
            >
              Auto-refund limit
            </label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">$</span>
              <Input
                // A new limit (or a reset) refills the box.
                key={refunds.limitUsd}
                id="refund-limit"
                name="limit"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                defaultValue={refunds.limitUsd}
                onBlur={(event) => saveLimit(event.target.value)}
                className="w-28"
              />
              <Button type="submit" variant="outline" size="sm">
                Save
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => refundStore.setLimit(preset)}
                aria-pressed={refunds.limitUsd === preset}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                  refunds.limitUsd === preset
                    ? "bg-primary text-primary-foreground border-primary"
                    : "hover:border-primary",
                )}
              >
                {money(preset)}
              </button>
            ))}
          </div>
          <p
            data-testid="limit-summary"
            className="text-muted-foreground w-full text-sm"
          >
            Refunds up to {money(refunds.limitUsd)} go through on their own.
            Anything above it needs your approval.
          </p>
        </form>
      </section>

      {/* At a glance. */}
      <section className="grid grid-cols-3 gap-3">
        <Stat label="Refunded" value={money(total("refunded"))} />
        <Stat
          label="Needs review"
          value={String(waiting.length)}
          highlight={waiting.length > 0}
        />
        <Stat label="Kept by rejecting" value={money(total("rejected"))} />
      </section>

      {/* The review queue: a person's decision. */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <InboxIcon className="size-5" /> Your review queue
        </h2>
        {waiting.length === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 rounded-2xl border border-dashed p-4 text-sm">
            <HandIcon className="size-4 shrink-0" />
            Nothing to review. Refunds over {money(refunds.limitUsd)} will wait
            here for you.
          </p>
        ) : (
          <ul className="space-y-3">
            {waiting.map((order) => (
              <li
                key={order.id}
                data-testid="waiting-refund"
                className="border-chart-4 bg-chart-4/10 rounded-2xl border-2 p-4"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold tracking-widest uppercase">
                      <BotIcon className="size-3.5" /> The Refund agent is
                      waiting on you
                    </p>
                    <p className="mt-1 text-lg font-bold">
                      #{order.id} {order.item}
                    </p>
                    <p className="text-muted-foreground text-sm">
                      {order.detail} · {money(order.amountUsd)} is{" "}
                      {money(order.amountUsd - refunds.limitUsd)} over your{" "}
                      {money(refunds.limitUsd)} limit
                    </p>
                  </div>
                  <span className="font-display text-3xl font-bold">
                    {money(order.amountUsd)}
                  </span>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    onClick={() => refundStore.decide(order.id, "approved")}
                    aria-label={`Approve refund for order ${order.id}`}
                    className="flex-1"
                  >
                    <CheckIcon /> Approve refund
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => refundStore.decide(order.id, "rejected")}
                    aria-label={`Reject refund for order ${order.id}`}
                    className="flex-1"
                  >
                    <XIcon /> Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The decision log: who decided what, and when. */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <HistoryIcon className="size-5" /> Decision log
        </h2>
        {log.length === 0 ? (
          <p className="text-muted-foreground rounded-2xl border border-dashed p-4 text-sm">
            Every refund decision appears here, marked Code or Person.
          </p>
        ) : (
          <ol
            data-testid="decision-log"
            className="bg-card divide-y rounded-2xl border"
          >
            {[...log].reverse().map((entry) => (
              <li
                key={entry.id}
                data-testid="log-entry"
                data-by={entry.by}
                className="flex items-start gap-3 px-4 py-2.5 text-sm"
              >
                <Badge who={entry.by} />
                <span className="min-w-0 flex-1">{entry.text}</span>
                <time
                  dateTime={entry.at}
                  className="text-muted-foreground font-mono text-xs whitespace-nowrap"
                >
                  {time(entry.at)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* The customer's orders. */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold">{CUSTOMER}&apos;s orders</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refundStore.reset()}
            className="text-muted-foreground"
          >
            <RotateCcwIcon /> Reset demo
          </Button>
        </div>
        <div className="bg-card overflow-hidden rounded-2xl border">
          <div className="text-muted-foreground bg-secondary/60 hidden grid-cols-[4rem_1fr_7rem_6rem_5rem] gap-3 px-4 py-2 text-[11px] font-semibold tracking-widest uppercase sm:grid">
            <span>Order</span>
            <span>Item</span>
            <span>Status</span>
            <span>Decided by</span>
            <span className="text-right">Amount</span>
          </div>
          <ul className="divide-y">
            {ORDERS.map((order) => {
              const status = STATUS[statusOf(refunds, order.id)];
              const by = decidedBy(order.id);
              const settled = statusOf(refunds, order.id) !== "paid";
              return (
                <li
                  key={order.id}
                  data-testid="order"
                  className="grid grid-cols-[4rem_1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[4rem_1fr_7rem_6rem_5rem]"
                >
                  <span className="text-muted-foreground font-mono text-sm">
                    #{order.id}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{order.item}</span>
                    <span className="text-muted-foreground block text-xs">
                      {order.detail}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "w-fit rounded-full px-2 py-0.5 text-xs font-semibold",
                      status.className,
                    )}
                  >
                    {status.label}
                  </span>
                  <span className="hidden sm:block">
                    {settled && by && by !== "setting" ? (
                      <Badge who={by} />
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </span>
                  <span className="hidden text-right font-mono sm:block">
                    {money(order.amountUsd)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}

function Badge({ who }: { who: LogEntry["by"] }) {
  const { label, className, icon } = WHO[who];
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wider uppercase",
        className,
      )}
    >
      {icon}
      {label}
    </span>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "bg-card rounded-2xl border p-3",
        highlight && "border-chart-4 bg-chart-4/10",
      )}
    >
      <p className="text-muted-foreground text-[11px] font-semibold tracking-widest uppercase">
        {label}
      </p>
      <p className="font-display mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
