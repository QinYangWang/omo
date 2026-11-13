// Per-turn agent metrics: how many tools ran and how long they took, how
// many skills were used, how much time the model spent before each answer,
// how many steps a turn took, and the token/cache split the provider
// reported. Times come from the committed entries a conversation watch
// delivers, so a turn is measured without asking the provider anything.
import { hostRecordMetric } from "./host";

export type RunMetric = {
  sessionId: string;
  conversationId: string;
  agent: string;
  parentConversationId?: string;
  turn: number;
  startedAt: number;
  durationMs: number;
  steps: number;
  toolCalls: number;
  toolMs: number;
  skillHits: number;
  skills: string[];
  thinkingMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  failure?: string;
};

type Acc = Omit<
  RunMetric,
  "sessionId" | "conversationId" | "agent" | "parentConversationId" | "turn" | "durationMs" | "failure"
>;

export let sessionId = "";

export const setSessionId = (id: string) => {
  sessionId = String(id ?? "");
};

const emptyAcc = (at: number): Acc => ({
  startedAt: at,
  steps: 0,
  toolCalls: 0,
  toolMs: 0,
  skillHits: 0,
  skills: [],
  thinkingMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export class AgentTracker {
  private acc: Acc = emptyAcc(0);
  private lastAt = 0;
  private turn = 0;
  private seen = new Set<string>();
  private watch: any;

  constructor(
    readonly conversationId: string,
    readonly agent: string,
    readonly parentConversationId?: string,
  ) {
    this.lastAt = Date.now();
  }

  /**
   * Follow a conversation watch so entries are timed as they are committed.
   * A watch has one listener, so the root passes listen=false and forwards
   * values itself.
   */
  attach(watch: any, listen = true) {
    this.watch = watch;
    this.observe(watch?.value);
    if (listen) {
      watch?.start?.((call: any) => {
        if (call.kind === "value") this.observe(call.value);
      });
    }
  }

  /** Count entries newer than any seen before; call with the watch's value. */
  observe(view: any) {
    const now = Date.now();
    for (const entry of view?.entries ?? []) {
      const id = String(entry?.id ?? "");
      if (!id || this.seen.has(id)) continue;
      this.seen.add(id);
      const delta = Math.max(0, now - this.lastAt);
      this.lastAt = now;
      switch (entry.kind) {
        case "pi.assistant": {
          this.acc.steps += 1;
          this.acc.thinkingMs += delta;
          const usage = entry.model?.[0]?.usage;
          if (usage) {
            this.acc.inputTokens += num(usage.input);
            this.acc.outputTokens += num(usage.output);
            this.acc.cacheReadTokens += num(usage.cacheRead);
            this.acc.cacheWriteTokens += num(usage.cacheWrite);
            this.acc.reasoningTokens += num(usage.reasoning);
          }
          break;
        }
        case "pi.tool-result": {
          this.acc.toolCalls += 1;
          this.acc.toolMs += delta;
          break;
        }
        default:
          break;
      }
    }
  }

  /** Start the next turn: everything observed from here on belongs to it. */
  begin() {
    this.turn += 1;
    const now = Date.now();
    this.acc = emptyAcc(now);
    this.lastAt = now;
  }

  /** A skill the turn used, counted once per name. */
  hitSkill(name: string) {
    const skill = String(name ?? "").trim();
    if (!skill) return;
    this.acc.skillHits += 1;
    if (!this.acc.skills.includes(skill)) this.acc.skills.push(skill);
  }

  /** Finish the turn, persist its metric, and reset for the next one. */
  end(failure?: string): RunMetric {
    const now = Date.now();
    const metric: RunMetric = {
      sessionId,
      conversationId: this.conversationId,
      agent: this.agent,
      parentConversationId: this.parentConversationId,
      turn: this.turn,
      startedAt: this.acc.startedAt,
      durationMs: Math.max(0, now - this.acc.startedAt),
      steps: this.acc.steps,
      toolCalls: this.acc.toolCalls,
      toolMs: this.acc.toolMs,
      skillHits: this.acc.skillHits,
      skills: this.acc.skills.slice(),
      thinkingMs: this.acc.thinkingMs,
      inputTokens: this.acc.inputTokens,
      outputTokens: this.acc.outputTokens,
      cacheReadTokens: this.acc.cacheReadTokens,
      cacheWriteTokens: this.acc.cacheWriteTokens,
      reasoningTokens: this.acc.reasoningTokens,
      failure: failure || undefined,
    };
    hostRecordMetric(metric);
    this.acc = emptyAcc(now);
    return metric;
  }

  async stop() {
    try {
      await this.watch?.stop?.();
    } catch {}
  }
}

const trackers = new Map<string, AgentTracker>();

export const trackConversation = (tracker: AgentTracker) => {
  trackers.set(tracker.conversationId, tracker);
  return tracker;
};

export const trackerFor = (conversationId: string) => trackers.get(String(conversationId));

export const hitSkill = (conversationId: string, name: string) => {
  trackerFor(conversationId)?.hitSkill(name);
};

/** Let a commit published by the just-settled run reach its watch listener. */
export const yieldToWatch = () =>
  new Promise<void>((resolve) => {
    try {
      setTimeout(resolve, 0);
    } catch {
      queueMicrotask(resolve);
    }
  });
