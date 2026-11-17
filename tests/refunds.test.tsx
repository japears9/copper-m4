// Module 4: refunds. The rule is code, Copper hands refunds to a separate
// Refund agent, and a person approves or rejects refunds over the limit.
// Fast checks with a mock model, so they need no AI key and cost nothing.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { finalValue } from "@/lib/ai/live";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import {
  decideRefund,
  DEFAULT_LIMIT_USD,
  ORDERS,
  type RefundState,
} from "@/lib/copper/refunds";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

let logged: Record<string, unknown>[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    if (args[0] === "[ai_calls]") logged.push(JSON.parse(args[1] as string));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
  window.localStorage.clear();
});

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];
let callId = 0;
const calls = (toolName: string, input: unknown): StreamPart[] => {
  const id = `call-${++callId}`;
  return [
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: JSON.stringify(input) },
    { type: "tool-input-end", id },
    {
      type: "tool-call",
      toolCallId: id,
      toolName,
      input: JSON.stringify(input),
    },
    finish("tool-calls"),
  ];
};
/** A mock model that streams each of `steps` in turn, across both agents. */
function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

async function loadAsk() {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  return import("@/lib/copper/assistant/ask");
}

const state = (
  limitUsd: number,
  statuses: RefundState["statuses"] = {},
): RefundState => ({ limitUsd, statuses });

const order = (item: string) => ORDERS.find((o) => o.item === item)!;
const HOME = order("Copper Home"); // $149
const ANNUAL = order("Copper Plus, annual"); // $79

describe("The refund rule (code, not the model)", () => {
  it("refunds at or under the limit and waits over it", () => {
    expect(DEFAULT_LIMIT_USD).toBe(100);
    expect(decideRefund(state(100), ANNUAL.id)).toMatchObject({
      result: "refunded",
      status: "refunded",
    });
    expect(decideRefund(state(79), ANNUAL.id).result).toBe("refunded");
    expect(decideRefund(state(100), HOME.id)).toMatchObject({
      result: "waiting_for_approval",
      status: "waiting",
    });
  });

  it("with the limit at 0, every refund waits for a person", () => {
    for (const o of ORDERS)
      expect(decideRefund(state(0), o.id).result).toBe("waiting_for_approval");
  });

  it("never refunds the same order twice, and respects a person's rejection", () => {
    expect(
      decideRefund(state(1000, { [ANNUAL.id]: "refunded" }), ANNUAL.id).result,
    ).toBe("already_refunded");
    expect(
      decideRefund(state(1000, { [HOME.id]: "waiting" }), HOME.id).result,
    ).toBe("already_waiting");
    expect(
      decideRefund(state(1000, { [HOME.id]: "rejected" }), HOME.id).result,
    ).toBe("already_rejected");
  });

  it("accepts '#2044' and 'order 2044', and says when an order doesn't exist", () => {
    expect(decideRefund(state(100), `#${HOME.id}`).orderId).toBe(HOME.id);
    expect(decideRefund(state(100), `order ${HOME.id}`).orderId).toBe(HOME.id);
    expect(decideRefund(state(100), "9999").result).toBe("not_found");
  });
});

describe("Copper hands refunds to the Refund agent", () => {
  it("hands off, then the Refund agent's own tools ask the app, and it writes the reply", async () => {
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "Copper Home" }),
      calls("get_orders", {}),
      calls("refund_order", { orderId: HOME.id }),
      says("Your refund is waiting for a person to review."),
    );
    const { askCopper } = await loadAsk();
    const result = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund my Copper Home" }],
          useTools: true,
          refunds: state(100),
        })
      ).progress,
    );
    expect(result.status).toBe("done");
    expect(result.agent).toBe("refund");
    expect(result.steps.some((s) => s.type === "handoff")).toBe(true);
    const tools = toolCallsOf(result);
    expect(tools.map((t) => t.name)).toEqual([
      "transfer_to_refund_agent",
      "get_orders",
      "refund_order",
    ]);
    expect(tools[2].output).toMatchObject({
      orderId: HOME.id,
      result: "waiting_for_approval",
    });
    expect(result.reply).toBe("Your refund is waiting for a person to review.");

    // Two separate agents: different instructions and different tools.
    const [copper, refund] = [model.doStreamCalls[0], model.doStreamCalls[1]];
    const names = (c: typeof copper) => (c.tools ?? []).map((t) => t.name);
    expect(names(copper)).toContain("transfer_to_refund_agent");
    expect(names(copper)).not.toContain("refund_order");
    expect(names(refund)).toEqual(["get_orders", "refund_order"]);
    const system = (c: typeof copper) =>
      JSON.stringify(c.prompt.find((m) => m.role === "system")?.content);
    expect(system(refund)).toContain("You are the Refund agent");
    expect(system(copper)).not.toContain("You are the Refund agent");
    await vi.waitFor(() =>
      expect(logged.map((r) => r.feature)).toEqual([
        "ask-copper",
        "refund-agent",
      ]),
    );
  });

  it("off the Support page, Copper has no hand-off tool", async () => {
    model = modelStreaming(says("Sure."));
    const { askCopper } = await loadAsk();
    await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund please" }],
          useTools: true,
        })
      ).progress,
    );
    const names = (model.doStreamCalls[0].tools ?? []).map((t) => t.name);
    expect(names).not.toContain("transfer_to_refund_agent");
  });

  it("tells the customer about a decision only when the Refund Console shows it", async () => {
    model = modelStreaming(says("Good news: your refund was approved."));
    let { askCopper } = await loadAsk();
    const approved = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund Console update" }],
          useTools: true,
          refunds: state(100, { [HOME.id]: "refunded" }),
          consoleUpdate: { orderId: HOME.id, decision: "approved" },
        })
      ).progress,
    );
    expect(approved.agent).toBe("refund");
    expect(approved.reply).toContain("approved");
    expect(
      JSON.stringify(
        model.doStreamCalls[0].prompt.find((m) => m.role === "system"),
      ),
    ).toContain("APPROVED");

    // A faked "approved" while the order is still waiting gets nowhere.
    model = modelStreaming(says("Approved!"));
    ({ askCopper } = await loadAsk());
    const faked = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "x" }],
          useTools: true,
          refunds: state(100, { [HOME.id]: "waiting" }),
          consoleUpdate: { orderId: HOME.id, decision: "approved" },
        })
      ).progress,
    );
    expect(faked.status).toBe("error");
    expect(model.doStreamCalls).toHaveLength(0);
  });
});

describe("The Refund Console", () => {
  async function renderSupport() {
    vi.resetModules();
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const { default: Support } = await import("@/app/support/page");
    render(<Support />);
    return import("@/components/copper/refund-store");
  }

  it("lists the orders and the limit, and the limit can be changed", async () => {
    await renderSupport();
    expect(screen.getAllByTestId("order")).toHaveLength(ORDERS.length);
    expect(screen.getByTestId("limit-summary")).toHaveTextContent("$100");
    const input = screen.getByLabelText("Auto-refund limit");
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("limit-summary")).toHaveTextContent("$50");
  });

  it("a refund over the limit waits; Approve refunds it and Reject doesn't, and the chat hears about each", async () => {
    const { refundStore } = await renderSupport();
    const heard: string[] = [];
    refundStore.onDecision((d) => heard.push(`${d.orderId} ${d.decision}`));
    act(() => refundStore.apply(HOME.id, "waiting"));
    expect(screen.getByTestId("waiting-refund")).toHaveTextContent(
      "Copper Home",
    );
    fireEvent.click(screen.getByRole("button", { name: /approve refund/i }));
    expect(screen.queryByTestId("waiting-refund")).toBeNull();
    expect(refundStore.get().statuses[HOME.id]).toBe("refunded");

    const notes = order("Copper Notes");
    act(() => refundStore.apply(notes.id, "waiting"));
    fireEvent.click(screen.getByRole("button", { name: /reject refund/i }));
    expect(refundStore.get().statuses[notes.id]).toBe("rejected");
    expect(heard).toEqual([`${HOME.id} approved`, `${notes.id} rejected`]);

    // Approve only works on a refund that is waiting.
    act(() => refundStore.decide(notes.id, "approved"));
    expect(refundStore.get().statuses[notes.id]).toBe("rejected");
    act(() => refundStore.reset());
  });

  it("the decision log marks what code decided and what a person decided", async () => {
    const { refundStore } = await renderSupport();
    act(() => refundStore.apply(ANNUAL.id, "refunded"));
    act(() => refundStore.apply(HOME.id, "waiting"));
    fireEvent.click(screen.getByRole("button", { name: /approve refund/i }));
    act(() => refundStore.setLimit(0));

    const entries = screen.getAllByTestId("log-entry");
    // Newest first: the limit change, then the approval, then the two rulings.
    expect(entries.map((e) => e.dataset.by)).toEqual([
      "setting",
      "person",
      "code",
      "code",
    ]);
    expect(entries[3]).toHaveTextContent("refunded it automatically");
    expect(entries[2]).toHaveTextContent("held it for a person");
    expect(entries[1]).toHaveTextContent("you approved");
    expect(screen.getByTestId("limit-summary")).toHaveTextContent("$0");

    act(() => refundStore.reset());
    expect(screen.queryByTestId("decision-log")).toBeNull();
  });
});
