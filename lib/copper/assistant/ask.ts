"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// On the Support page (Module 4) Copper can also hand the chat to a second
// agent, the Refund agent, which then writes the reply.
import { hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { defaultModel, type ModelId } from "@/lib/ai/models";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import type { Progress, ToolStep } from "@/lib/copper/assistant/progress";
import {
  consoleUpdateInstructions,
  REFUND_INSTRUCTIONS,
  refundTools,
} from "@/lib/copper/assistant/refund-agent";
import { copperTools } from "@/lib/copper/assistant/tools";
import { findOrder, type RefundState, statusOf } from "@/lib/copper/refunds";

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** A person clicked Approve or Reject in the Refund Console. */
export type ConsoleUpdate = {
  orderId: string;
  decision: "approved" | "rejected";
};

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The Refund Console's limit and order statuses (Support page only). */
  refunds?: RefundState;
  /** Tell the customer about a Refund Console decision. */
  consoleUpdate?: ConsoleUpdate;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per question. */
const MAX_STEPS = 5;

/**
 * Free Gemini keys allow only a few requests a minute, and one refund takes
 * several (Copper, then the Refund agent's lookups and reply). When Google
 * says "slow down", wait and retry (about 2, 4, 8, 16 s) instead of failing.
 * Not exported: a "use server" file may only export async functions.
 */
const MAX_RETRIES = 1;

/** Give up on one model after this long and try the next one. */
const ATTEMPT_MS = 45_000;

/**
 * Models to fall back to, in order, after AI_MODEL. Each has its own free
 * daily allowance. Gemini 3 Flash is left out on purpose: Class Example 3's
 * site uses its allowance.
 */
const FALLBACK_MODELS: ModelId[] = [
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.8-flash",
];

function modelsToTry(): ModelId[] {
  const first = defaultModel();
  return [first, ...FALLBACK_MODELS.filter((m) => m !== first)];
}

const SORRY = "Sorry, something went wrong on my end. Please try again.";

const HANDOFF = "transfer_to_refund_agent";

// The browser sends the Refund Console's state, so check its shape here.
const refundStateSchema = z.object({
  limitUsd: z.number().min(0).max(1_000_000),
  statuses: z.record(
    z.string(),
    z.enum(["paid", "refunded", "waiting", "rejected"]),
  ),
});

const HANDOFF_INSTRUCTIONS = `

You work alongside the Refund agent. When the customer asks for a refund or their money back for something they bought, call ${HANDOFF} right away. Don't search the documents, ask questions or promise anything first: the Refund agent handles it from there.
Questions about the refund policy itself ("What's your refund policy?", "How many days do I have?") are not refund requests: answer those with search_docs as usual.`;

const handoffTool = {
  [HANDOFF]: tool({
    description:
      "Hands this chat to the Refund agent, who looks up the customer's orders and requests the refund. Use it whenever the customer wants money back for an order.",
    inputSchema: z.object({
      reason: z
        .string()
        .describe("What the customer wants refunded, in a few words."),
    }),
    execute: async () => ({ handedOff: true }),
  }),
};

export async function askCopper({
  messages,
  useTools,
  refunds: rawRefunds,
  consoleUpdate,
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: "copper",
  };
  const parsed = rawRefunds ? refundStateSchema.safeParse(rawRefunds) : null;
  const refunds = parsed?.success ? parsed.data : undefined;

  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep => step.type === "tool" && step.id === id,
    );

  /** Reads one agent's stream into `progress`. True if Copper handed off. */
  async function follow(
    result: ReturnType<typeof callStream>,
  ): Promise<boolean> {
    let handedOff = false;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking") last.text += part.text;
          else progress.steps.push({ type: "thinking", text: part.text });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: part.id,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          if (part.toolName === HANDOFF) handedOff = true;
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: part.toolCallId,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return handedOff;
  }

  /**
   * Runs one agent, falling back to the next model when Google says a model
   * is overloaded or out of free requests. Anything a failed attempt showed
   * is rolled back first, so the customer only sees the answer that worked.
   */
  async function followWithFallback(
    start: (model: ModelId) => ReturnType<typeof callStream>,
  ): Promise<boolean> {
    let lastError: unknown = new Error("No model to try.");
    for (const model of modelsToTry()) {
      const before = { steps: progress.steps.length, reply: progress.reply };
      try {
        return await follow(start(model));
      } catch (error) {
        lastError = error;
        console.error(
          `[ask-copper] ${model} failed, trying the next model:`,
          error instanceof Error ? error.message : String(error),
        );
        progress.steps.length = before.steps;
        progress.reply = before.reply;
        update(snapshot());
      }
    }
    throw lastError;
  }

  /** The Refund agent: its own instructions and tools, same conversation. */
  const refundAgent = (state: RefundState, instructions: string) =>
    followWithFallback((model) =>
      callStream(
        { module: 4, feature: "refund-agent", model },
        {
          messages,
          maxRetries: MAX_RETRIES,
          abortSignal: AbortSignal.timeout(ATTEMPT_MS),
          instructions,
          tools: refundTools(state),
          providerOptions: THOUGHT_SUMMARIES,
          stopWhen: stepCountIs(MAX_STEPS),
        },
      ),
    );

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    try {
      if (consoleUpdate) {
        // A Refund Console decision: the Refund agent tells the customer.
        // Only go ahead if the console's own state shows that decision.
        const order = findOrder(consoleUpdate.orderId);
        const expected =
          consoleUpdate.decision === "approved" ? "refunded" : "rejected";
        if (!useTools || !refunds || !order)
          throw new Error("Not a Refund Console update.");
        if (statusOf(refunds, order.id) !== expected)
          throw new Error("The Refund Console doesn't show that decision.");
        progress.agent = "refund";
        await refundAgent(
          refunds,
          consoleUpdateInstructions(order.id, consoleUpdate.decision),
        );
      } else {
        // Without tools, send no instructions either: "always use your tools"
        // with no tools makes the model answer with nothing.
        const canHandOff = useTools && refunds !== undefined;
        const handedOff = await followWithFallback((model) =>
          callStream(
            { module: 2, feature: "ask-copper", model },
            {
              messages,
              maxRetries: MAX_RETRIES,
              abortSignal: AbortSignal.timeout(ATTEMPT_MS),
              providerOptions: THOUGHT_SUMMARIES,
              ...(useTools && {
                instructions: canHandOff
                  ? COPPER_INSTRUCTIONS + HANDOFF_INSTRUCTIONS
                  : COPPER_INSTRUCTIONS,
                tools: canHandOff
                  ? { ...copperTools, ...handoffTool }
                  : copperTools,
                stopWhen: canHandOff
                  ? [stepCountIs(MAX_STEPS), hasToolCall(HANDOFF)]
                  : stepCountIs(MAX_STEPS),
              }),
            },
          ),
        );
        if (handedOff && refunds) {
          // Copper is done; anything it said is replaced by the Refund agent.
          progress.reply = "";
          progress.agent = "refund";
          progress.steps.push({ type: "handoff", to: "refund" });
          update(snapshot());
          await refundAgent(refunds, REFUND_INSTRUCTIONS);
        }
      }
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
    } catch (error) {
      // The reason goes to the server log (never the key), so it can be fixed.
      console.error(
        "[ask-copper] failed:",
        error instanceof Error ? error.message : String(error),
      );
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
    }
    done(snapshot());
  })();

  return { progress: live };
}
