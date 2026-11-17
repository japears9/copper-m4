"use client";

// Ask Copper: the floating shopping chat. Each answer is drawn as a rail of
// stations (the tools on offer, Copper's thinking, each tool call with what
// went in and what came back), then the reply, so shoppers can see how the
// answer was worked out.
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BrainIcon,
  MessageCircleIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Decision, refundStore } from "@/components/copper/refund-store";
import { SetupRequired } from "@/components/setup-required";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { readLive } from "@/lib/ai/live";
import {
  askCopper,
  type ChatMessage,
  type ConsoleUpdate,
} from "@/lib/copper/assistant/ask";
import { splitCitations } from "@/lib/copper/assistant/citations";
import {
  ALL_TOOL_LABELS,
  HANDOFF_TOOL_LABELS,
  type Progress,
  REFUND_TOOL_LABELS,
  type ToolStep,
  TOOL_LABELS,
} from "@/lib/copper/assistant/progress";
import { formatUsd, getPlans, getProducts } from "@/lib/copper/catalog";
import type { RefundStatus } from "@/lib/copper/refunds";
import { cn } from "@/lib/utils";

const STARTERS = [
  "How much is Copper Home with Copper Plus, paid yearly, for 2 years?",
  "Is Copper Notes in Night Sky in stock?",
  "Is Copper Plus cheaper monthly or yearly?",
];

/**
 * The Support page's starters, one per path through the refund flow at the
 * default $100 limit: $79 is refunded by code; $149 and $129 wait for a
 * person to approve or reject.
 */
const REFUND_STARTERS = [
  "Please refund my Copper Plus annual plan.",
  "I'd like my money back for my Copper Home.",
  "Can I get a refund for my Copper Notes?",
];

/** `note` turns come from the Refund Console, not the customer. */
type Turn = { question: string; progress: Progress; note?: boolean };
type Chats = { tools: Turn[]; noTools: Turn[] };

const WORKING: Progress = { steps: [], reply: "", status: "working" };

/** Records each refund the app's rule decided, so the Refund Console shows it. */
function applyRefunds(progress: Progress) {
  for (const step of progress.steps) {
    if (step.type !== "tool" || step.name !== "refund_order") continue;
    if (step.state !== "done") continue;
    const output = step.output as { orderId?: string; status?: RefundStatus };
    if (output?.orderId && output.status)
      refundStore.apply(output.orderId, output.status);
  }
}

export function AskCopper({
  aiConfigured,
  docked = false,
  refunds = false,
}: {
  aiConfigured: boolean;
  /** Stays open beside the page, which remains clickable (the Support page). */
  docked?: boolean;
  /** Copper can hand refund requests to the Refund agent (the Support page). */
  refunds?: boolean;
}) {
  const [open, setOpen] = useState(docked);
  const [useTools, setUseTools] = useState(true);
  const [chats, setChats] = useState<Chats>({ tools: [], noTools: [] });
  const [draft, setDraft] = useState("");
  const body = useRef<HTMLDivElement>(null);
  // The latest chats, for the Refund Console's updates (which arrive outside
  // a render), and the updates waiting for the current answer to finish.
  const chatsRef = useRef(chats);
  const queued = useRef<Decision[]>([]);
  const running = useRef(false);

  const key = useTools ? "tools" : "noTools";
  const turns = chats[key];
  const busy = turns.at(-1)?.progress.status === "working";
  const starters = refunds ? REFUND_STARTERS : STARTERS;

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  // Open from the header's #ask link or a page load at /#ask. Clicking the
  // link again fires no hashchange, so listen for the click too.
  useEffect(() => {
    const openOnHash = () => window.location.hash === "#ask" && setOpen(true);
    const openOnClick = (event: MouseEvent) => {
      if ((event.target as Element).closest?.('a[href$="#ask"]')) setOpen(true);
    };
    openOnHash();
    window.addEventListener("hashchange", openOnHash);
    document.addEventListener("click", openOnClick);
    return () => {
      window.removeEventListener("hashchange", openOnHash);
      document.removeEventListener("click", openOnClick);
    };
  }, []);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [chats, useTools]);

  async function send(question: string) {
    question = question.trim();
    if (!question || busy || running.current) return;
    setDraft("");
    await run(key, question);
  }

  /**
   * Sends one turn to askCopper and streams the answer in. A Refund Console
   * update is sent as a note, so the Refund agent can tell the customer.
   */
  async function run(
    chat: keyof Chats,
    question: string,
    consoleUpdate?: ConsoleUpdate,
  ) {
    running.current = true;
    const earlier = chatsRef.current[chat];
    const index = earlier.length;
    // Only finished turns go to the model: questions and Copper's replies.
    const messages: ChatMessage[] = [
      ...earlier.flatMap(({ question, progress }): ChatMessage[] => [
        { role: "user", content: question },
        { role: "assistant", content: progress.reply },
      ]),
      { role: "user", content: question },
    ];
    const setProgress = (progress: Progress) =>
      setChats((all) => ({
        ...all,
        [chat]: all[chat].map((turn, i) =>
          i === index ? { ...turn, progress } : turn,
        ),
      }));
    const turn: Turn = {
      question,
      progress: WORKING,
      ...(consoleUpdate && { note: true }),
    };
    chatsRef.current = { ...chatsRef.current, [chat]: [...earlier, turn] };
    setChats((all) => ({ ...all, [chat]: [...all[chat], turn] }));
    try {
      const { progress } = await askCopper({
        messages,
        useTools: chat === "tools",
        ...(refunds && { refunds: refundStore.get() }),
        ...(consoleUpdate && { consoleUpdate }),
      });
      for await (const update of readLive(progress)) {
        if (refunds) applyRefunds(update);
        setProgress(update);
      }
    } catch {
      setProgress({
        steps: [],
        reply: "Sorry, I couldn't reach Copper. Please try again.",
        status: "error",
      });
    }
    running.current = false;
    const next = queued.current.shift();
    if (next) void tellCustomer(next);
  }

  /** A person approved or rejected a refund: the Refund agent tells the customer. */
  function tellCustomer(decision: Decision) {
    if (running.current) {
      queued.current.push(decision);
      return;
    }
    return run(
      "tools",
      `Refund Console: order #${decision.orderId} was ${decision.decision}.`,
      decision,
    );
  }

  // Listen for Approve and Reject in the Refund Console.
  const tellRef = useRef(tellCustomer);
  useEffect(() => {
    tellRef.current = tellCustomer;
  });
  useEffect(() => {
    if (!refunds) return;
    return refundStore.onDecision((decision) => {
      setUseTools(true);
      void tellRef.current(decision);
    });
  }, [refunds]);

  return (
    <>
      {!open && (
        <Button
          data-testid="ask-copper-launcher"
          aria-label="Ask Copper"
          onClick={() => setOpen(true)}
          className="fixed right-4 bottom-4 z-40 h-12 gap-2 rounded-full px-5 shadow-lg sm:right-6 sm:bottom-6"
        >
          <MessageCircleIcon className="size-5" />
          Ask Copper
        </Button>
      )}
      <Sheet open={open} onOpenChange={setOpen} modal={!docked}>
        <SheetContent
          data-testid="ask-copper"
          side="right"
          showCloseButton={false}
          onInteractOutside={(event) => docked && event.preventDefault()}
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          <header className="bg-chart-5 dark:bg-background text-white">
            <div className="flex items-center gap-3 px-4 pt-4 pb-3">
              <span className="bg-primary flex size-10 shrink-0 items-center justify-center rounded-full">
                <MessageCircleIcon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-base font-bold text-white">
                  Ask Copper
                </SheetTitle>
                <SheetDescription className="text-xs text-white/70">
                  {refunds
                    ? "Copper answers; the Refund agent handles refunds."
                    : "Prices, totals and stock, checked with tools."}
                </SheetDescription>
              </div>
              <SheetClose asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-white hover:bg-white/10 hover:text-white"
                >
                  <XIcon />
                  <span className="sr-only">Close</span>
                </Button>
              </SheetClose>
            </div>
            {aiConfigured && (
              <div className="flex items-center gap-3 bg-white/10 px-4 py-2">
                <div className="flex-1 text-sm">
                  <span className="font-semibold">Use tools</span>
                  <span className="ml-2 text-xs text-white/70">
                    {useTools ? "Checks every answer" : "Model guesses alone"}
                  </span>
                </div>
                <Switch
                  aria-label="Use tools"
                  checked={useTools}
                  onCheckedChange={setUseTools}
                />
              </div>
            )}
          </header>

          {aiConfigured ? (
            <>
              <div
                ref={body}
                className="bg-secondary flex-1 space-y-6 overflow-y-auto px-4 py-5"
              >
                {turns.map((turn, i) => (
                  <div key={i} className="space-y-4">
                    {turn.note ? (
                      <p
                        data-testid="console-note"
                        className="border-chart-3 bg-chart-3/10 mx-auto w-fit max-w-[90%] rounded-full border px-3 py-1 text-center text-xs font-semibold"
                      >
                        {turn.question}
                      </p>
                    ) : (
                      <p className="bg-primary text-primary-foreground ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2">
                        {turn.question}
                      </p>
                    )}
                    <Answer
                      progress={turn.progress}
                      useTools={useTools}
                      refunds={refunds}
                    />
                  </div>
                ))}
                {!busy && (
                  <div className="space-y-2">
                    {turns.length === 0 && (
                      <p className="text-muted-foreground text-sm">
                        {refunds
                          ? "Hi, I'm Copper! Ask me anything, or ask for a refund. Try one of these:"
                          : "Hi, I'm Copper! Ask me about prices, totals or stock. Try one of these:"}
                      </p>
                    )}
                    {starters.map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        onClick={() => send(starter)}
                        className="bg-background hover:border-primary block w-full rounded-xl border px-3 py-2 text-left text-sm transition-colors"
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  send(draft);
                }}
                className="bg-background flex items-center gap-2 border-t p-3"
              >
                <input
                  aria-label="Your question"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    refunds ? "Ask for a refund…" : "Ask about prices or stock…"
                  }
                  className="bg-background focus-visible:ring-ring h-10 flex-1 rounded-full border px-4 text-sm outline-none focus-visible:ring-2"
                />
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send"
                  disabled={busy || !draft.trim()}
                  className="size-10 rounded-full"
                >
                  <ArrowUpIcon />
                </Button>
              </form>
            </>
          ) : (
            <div className="bg-secondary flex-1 overflow-y-auto px-4">
              <SetupRequired service="ai" />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** One answer: the rail of stations, then Copper's reply. */
function Answer({
  progress,
  useTools,
  refunds = false,
}: {
  progress: Progress;
  useTools: boolean;
  refunds?: boolean;
}) {
  const { steps, reply, status } = progress;
  const used = new Set(
    steps.filter((s): s is ToolStep => s.type === "tool").map((s) => s.name),
  );
  const working = status === "working";
  let toolCount = 0;
  // A Refund Console update goes straight to the Refund agent: no hand-off.
  const refundOnly =
    progress.agent === "refund" && !steps.some((s) => s.type === "handoff");
  const handoffAt = steps.findIndex((s) => s.type === "handoff");
  /** Who is acting at step i: Copper, or the Refund agent after the hand-off. */
  const speaker = (i: number) =>
    refundOnly || (handoffAt >= 0 && i > handoffAt)
      ? "The Refund agent"
      : "Copper";
  const firstTools = refundOnly
    ? REFUND_TOOL_LABELS
    : refunds
      ? { ...TOOL_LABELS, ...HANDOFF_TOOL_LABELS }
      : TOOL_LABELS;
  return (
    <div className="space-y-3">
      <div className="relative space-y-4 pl-9">
        <span
          aria-hidden
          className={cn(
            "absolute top-3 bottom-3 left-[11px] w-0.5 bg-gradient-to-b",
            useTools
              ? "from-primary via-accent to-accent"
              : "from-chart-3 to-chart-3",
          )}
        />
        <Station
          node={<WrenchIcon className="size-3" />}
          nodeClass="bg-muted-foreground"
          label={
            !useTools
              ? "Tools given to Copper: none"
              : refundOnly
                ? "Tools the Refund agent can use"
                : "Tools Copper can use"
          }
        >
          <ToolChips
            names={Object.keys(firstTools)}
            used={used}
            useTools={useTools}
          />
          {!useTools && (
            <p className="text-muted-foreground mt-1.5 text-xs">
              Copper has to answer from memory alone.
            </p>
          )}
        </Station>

        {steps.map((step, i) =>
          step.type === "handoff" ? (
            <Station
              key={i}
              node={<ArrowRightIcon className="size-3" />}
              nodeClass="bg-chart-3"
              label="Copper handed the chat to the Refund agent"
            >
              <div
                data-testid="handoff"
                className="border-chart-3 bg-card space-y-2 rounded-xl border p-3 text-sm"
              >
                <p>
                  A second agent, with its own instructions and tools, takes
                  over this refund request.
                </p>
                <ToolChips
                  names={Object.keys(REFUND_TOOL_LABELS)}
                  used={used}
                  useTools
                />
              </div>
            </Station>
          ) : step.type === "thinking" ? (
            <Station
              key={i}
              node={<BrainIcon className="size-3" />}
              nodeClass={useTools ? "bg-primary" : "bg-chart-3"}
              label={`${speaker(i)} is thinking`}
            >
              <p
                data-testid="thinking"
                className="text-muted-foreground border-l-2 pl-3 text-sm whitespace-pre-wrap italic"
              >
                <InlineMarkdown text={step.text} />
              </p>
            </Station>
          ) : (
            <Station
              key={i}
              node={<WrenchIcon className="size-3" />}
              nodeClass="bg-accent"
              label={
                step.state === "calling"
                  ? `${speaker(i)} is calling a tool`
                  : `${speaker(i)} called a tool`
              }
            >
              <ToolCard step={step} number={++toolCount} />
            </Station>
          ),
        )}

        {working && (
          <div className="relative">
            <span className="bg-primary ring-secondary absolute top-0.5 -left-9 flex size-6 animate-pulse items-center justify-center gap-0.5 rounded-full ring-4">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="size-1 animate-bounce rounded-full bg-white"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
            <p className="text-muted-foreground pt-1 text-sm">
              {reply
                ? "Writing the answer…"
                : !useTools
                  ? "Answering from memory…"
                  : steps.length
                    ? "Deciding what to do next…"
                    : "Reading your question…"}
            </p>
          </div>
        )}
      </div>

      {(reply || !working) && (
        <div className="bg-card ml-2 rounded-2xl rounded-tl-sm border p-4 shadow-xs">
          <p
            data-testid="reply-from"
            className={cn(
              "mb-1 text-xs font-bold",
              progress.agent === "refund" ? "text-chart-3" : "text-primary",
            )}
          >
            {progress.agent === "refund" ? "Refund agent" : "Copper"}
          </p>
          {!useTools && (
            <div className="border-chart-3 bg-chart-3/10 mb-3 rounded-lg border p-3 text-xs">
              <p className="flex items-center gap-1.5 font-bold">
                <TriangleAlertIcon className="text-chart-3 size-4" />
                Answered without tools: may be made up
              </p>
              <p className="text-muted-foreground mt-1">
                With tools off, Copper can&apos;t see today&apos;s prices or
                stock. The AI only has what it learned in training, so it fills
                the gaps with guesses that sound right. That&apos;s a
                hallucination.
              </p>
            </div>
          )}
          <p className="text-sm whitespace-pre-wrap">
            <CitedText text={reply} />
            {working && (
              <span className="bg-primary ml-0.5 inline-block h-4 w-0.5 animate-pulse align-middle" />
            )}
          </p>
        </div>
      )}
    </div>
  );
}

/** The tools an agent can use, with the ones it used highlighted. */
function ToolChips({
  names,
  used,
  useTools,
}: {
  names: string[];
  used: Set<string>;
  useTools: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {names.map((name) => (
        <span
          key={name}
          className={cn(
            "rounded-md px-2 py-0.5 font-mono text-xs",
            !useTools && "text-muted-foreground bg-background line-through",
            useTools && used.has(name) && "bg-accent font-bold text-white",
            useTools &&
              !used.has(name) &&
              "bg-background text-muted-foreground",
          )}
        >
          {name}
        </span>
      ))}
    </div>
  );
}

function Station({
  node,
  nodeClass,
  label,
  children,
}: {
  node: ReactNode;
  nodeClass: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="relative">
      <span
        className={cn(
          "ring-secondary absolute top-0 -left-9 flex size-6 items-center justify-center rounded-full text-white ring-4",
          nodeClass,
        )}
      >
        {node}
      </span>
      <p className="text-muted-foreground mb-2 pt-1 text-[11px] font-semibold tracking-widest uppercase">
        {label}
      </p>
      {children}
    </section>
  );
}

/** A reply with each [Title, p. N] citation linked to that page of the PDF. */
function CitedText({ text }: { text: string }) {
  return splitCitations(text).map((part, i) =>
    typeof part === "string" ? (
      part
    ) : (
      <a
        key={i}
        href={part.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary font-medium underline underline-offset-2"
      >
        {part.label}
      </a>
    ),
  );
}

/** Thought summaries arrive as markdown: render **bold** and `code`. */
function InlineMarkdown({ text }: { text: string }) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return (
        <strong key={i} className="text-foreground not-italic">
          {part.slice(2, -2)}
        </strong>
      );
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code key={i} className="font-mono not-italic">
          {part.slice(1, -1)}
        </code>
      );
    return part;
  });
}

function ToolCard({ step, number }: { step: ToolStep; number: number }) {
  return (
    <div
      data-testid="tool-call"
      data-tool={step.name}
      className="bg-card overflow-hidden rounded-xl border text-sm"
    >
      <div className="bg-accent flex items-center gap-2 px-3 py-2 text-white">
        <span className="font-mono font-bold">{step.name}()</span>
        <span className="rounded bg-white/20 px-1.5 text-[10px]">
          tool {number}
        </span>
        <span className="ml-auto text-xs text-white/80">
          {ALL_TOOL_LABELS[step.name] ?? "Using a tool"}
        </span>
      </div>
      <div className="space-y-2 px-3 py-3">
        <p className="text-muted-foreground flex items-center gap-1 text-[11px] font-semibold tracking-widest uppercase">
          <ArrowRightIcon className="size-3" /> What Copper sent
        </p>
        {step.input === undefined ? (
          <p className="text-muted-foreground text-xs italic">
            filling in the details…
          </p>
        ) : (
          <ToolInput name={step.name} input={step.input} />
        )}
      </div>
      <div className="bg-accent/10 space-y-2 border-t px-3 py-3">
        <p className="text-muted-foreground flex items-center gap-1 text-[11px] font-semibold tracking-widest uppercase">
          <ArrowLeftIcon className="size-3" /> What came back
        </p>
        {step.state === "calling" ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Spinner className="size-3" /> the app is running the code…
          </p>
        ) : step.state === "error" ? (
          <p className="text-chart-3 text-xs">{String(step.output)}</p>
        ) : (
          <ToolOutput name={step.name} output={step.output} />
        )}
      </div>
    </div>
  );
}

const NAMES: Record<string, string> = Object.fromEntries([
  ...getProducts().map((p) => [p.id, p.name]),
  ...getPlans().map((p) => [p.id, p.name]),
]);

const nameOf = (value: unknown) =>
  Array.isArray(value)
    ? value.map((v) => NAMES[String(v)] ?? String(v)).join(", ") || "None"
    : (NAMES[String(value)] ?? String(value));

const NO_INPUT: Record<string, string> = {
  get_prices: "Nothing, it just asked for the price list",
  get_products: "Nothing, it just asked what Copper sells",
  get_orders: "Nothing, it just asked for the customer's orders",
};

/** What refund_order's answer means, in plain English. */
const REFUND_RESULTS: Record<string, { label: string; className: string }> = {
  refunded: {
    label: "Refunded automatically (at or under the limit)",
    className: "bg-accent text-white",
  },
  waiting_for_approval: {
    label: "Over the limit: waiting for a person",
    className: "bg-chart-3 text-white",
  },
  already_refunded: {
    label: "Already refunded",
    className: "bg-muted text-foreground",
  },
  already_waiting: {
    label: "Already waiting for a person",
    className: "bg-muted text-foreground",
  },
  already_rejected: {
    label: "Already rejected by a person",
    className: "bg-muted text-foreground",
  },
  not_found: { label: "No such order", className: "bg-muted text-foreground" },
};

const ORDER_STATUS: Record<string, string> = {
  paid: "Paid",
  refunded: "Refunded",
  waiting: "Waiting",
  rejected: "Rejected",
};

function ToolInput({ name, input }: { name: string; input: unknown }) {
  const entries = Object.entries((input ?? {}) as Record<string, unknown>);
  if (entries.length === 0)
    return (
      <p className="text-muted-foreground text-xs">
        {NO_INPUT[name] ?? "Nothing"}
      </p>
    );
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {entries.map(([field, value]) => (
        <div key={field} className="contents">
          <dt className="text-muted-foreground capitalize">{field}</dt>
          <dd className="font-medium">{nameOf(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any -- tool outputs arrive untyped from the stream */
function ToolOutput({ name, output }: { name: string; output: any }) {
  if (name === "calculate_cost" && output?.lines)
    return (
      <div className="text-xs">
        {output.lines.map((line: any) => (
          <div key={line.item} className="flex justify-between py-0.5">
            <span>{line.item}</span>
            <span className="font-mono">{formatUsd(line.usd)}</span>
          </div>
        ))}
        <div className="mt-1 flex items-baseline justify-between border-t pt-2">
          <span className="font-semibold">Total</span>
          <span className="text-primary text-xl font-bold">
            {formatUsd(output.totalUsd)}
          </span>
        </div>
      </div>
    );
  if (name === "get_products" && output?.products)
    return (
      <div className="space-y-2 text-xs">
        {output.products.map((p: any) => (
          <div key={p.id}>
            <div className="flex justify-between font-medium">
              <span>{p.name}</span>
              <span className="font-mono">{formatUsd(p.priceUsd)}</span>
            </div>
            <p className="text-muted-foreground">{p.type}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {p.colors.map((c: string) => (
                <span key={c} className="bg-accent/15 rounded-full px-2 py-0.5">
                  {c}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  if (name === "get_prices" && output?.products)
    return (
      <div className="text-xs">
        {output.products.map((p: any) => (
          <div key={p.id} className="flex justify-between py-0.5">
            <span>{p.name}</span>
            <span className="font-mono">{formatUsd(p.priceUsd)}</span>
          </div>
        ))}
        {output.plans
          .filter((p: any) => p.monthlyUsd > 0)
          .map((p: any) => (
            <div key={p.id} className="flex justify-between py-0.5">
              <span>{p.name}</span>
              <span className="font-mono">
                {formatUsd(p.monthlyUsd)}/mo · {formatUsd(p.annualUsd)}/yr
              </span>
            </div>
          ))}
      </div>
    );
  if (name === "check_availability" && output?.status) {
    if (output.status === "unavailable")
      return <p className="text-xs">{output.message}</p>;
    if (output.status === "not_a_color")
      return (
        <p className="text-xs">
          {output.product} doesn&apos;t come in {output.color}. It comes in{" "}
          {output.colors.join(", ")}.
        </p>
      );
    return (
      <div className="space-y-1 text-xs">
        {output.colors.map((c: any) => (
          <div key={c.color} className="flex items-center justify-between">
            <span>{c.color}</span>
            <StockPill stock={c.stock} restockDate={c.restockDate} />
          </div>
        ))}
      </div>
    );
  }
  if (name === "search_docs" && output?.matches)
    return (
      <ol className="space-y-2 text-xs">
        {output.matches.map((m: any) => (
          <li key={`${m.url}-${m.text}`} className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <a
                href={m.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary font-medium underline-offset-2 hover:underline"
              >
                {m.title}, page {m.page}
              </a>
              <span className="text-muted-foreground shrink-0 font-mono">
                {m.score.toFixed(2)}
              </span>
            </div>
            <p className="text-muted-foreground line-clamp-3">{m.text}</p>
          </li>
        ))}
      </ol>
    );
  if (name === "transfer_to_refund_agent")
    return <p className="text-xs">Handed off to the Refund agent.</p>;
  if (name === "get_orders" && output?.orders)
    return (
      <div className="text-xs">
        {output.orders.map((o: any) => (
          <div key={o.id} className="flex justify-between gap-2 py-0.5">
            <span>
              #{o.id} {o.item}
            </span>
            <span className="font-mono">
              {formatUsd(o.amountUsd)} · {ORDER_STATUS[o.status] ?? o.status}
            </span>
          </div>
        ))}
      </div>
    );
  if (name === "refund_order" && output?.result) {
    const result = REFUND_RESULTS[output.result];
    return (
      <div className="space-y-1.5 text-xs">
        {output.item && (
          <div className="flex justify-between font-medium">
            <span>
              #{output.orderId} {output.item}
            </span>
            <span className="font-mono">{formatUsd(output.amountUsd)}</span>
          </div>
        )}
        <Pill className={result?.className ?? "bg-muted"}>
          {result?.label ?? output.result}
        </Pill>
        <p className="text-muted-foreground">
          The app&apos;s rule decided this, not the AI.
        </p>
      </div>
    );
  }
  // A tool without its own layout yet: show what came back as plain text.
  return (
    <pre className="max-h-48 overflow-auto text-xs whitespace-pre-wrap">
      {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
    </pre>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function StockPill({
  stock,
  restockDate,
}: {
  stock: string;
  restockDate: string | null;
}) {
  if (stock === "in_stock")
    return <Pill className="bg-accent text-white">In stock</Pill>;
  if (stock === "low_stock")
    return <Pill className="bg-chart-4 text-chart-5">Low stock</Pill>;
  const date = restockDate
    ? new Date(`${restockDate}T12:00:00`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "later";
  return (
    <Pill className="bg-chart-3 text-white">Back-ordered until {date}</Pill>
  );
}

function Pill({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-semibold",
        className,
      )}
    >
      {children}
    </span>
  );
}
