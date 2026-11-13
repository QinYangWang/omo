// Subagents: a model tool that delegates work to child conversations in the
// same workspace. Child conversations are owned by the calling tool task, so
// aborting the call aborts them, and the caller is only idle once they are.
// `depends_on` orders the children and feeds an agent the results it relies
// on, which is the one way agents see each other's work.
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { hostRecordAgent } from "./host";
import { AgentTracker, sessionId, trackConversation, yieldToWatch } from "./metrics";

const MAX_AGENTS = 6;
const MAX_ANSWER_CHARS = 6000;

type AgentSpec = { name: string; task: string; dependsOn: string[] };
type AgentResult = { status: string; text: string; conversationId: string; failure?: string };

const textOf = (message: any): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => (block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (clipped)` : text);

/** Normalize the tool arguments and reject specs whose dependencies cannot be satisfied. */
const parseSpecs = (raw: any): AgentSpec[] => {
  const specs: AgentSpec[] = (Array.isArray(raw) ? raw : []).map((item: any, index: number) => ({
    name: String(item?.name ?? `agent-${index + 1}`).trim() || `agent-${index + 1}`,
    task: String(item?.task ?? "").trim(),
    dependsOn: Array.isArray(item?.depends_on) ? item.depends_on.map((dep: any) => String(dep).trim()).filter(Boolean) : [],
  }));
  if (specs.length === 0) throw new Error("agents must contain at least one agent");
  if (specs.length > MAX_AGENTS) throw new Error(`at most ${MAX_AGENTS} agents per call`);
  const names = new Set<string>();
  for (const spec of specs) {
    if (!spec.task) throw new Error(`agent ${spec.name} has no task`);
    if (names.has(spec.name)) throw new Error(`agent name ${spec.name} is used twice`);
    names.add(spec.name);
  }
  for (const spec of specs) {
    for (const dep of spec.dependsOn) {
      if (!names.has(dep)) throw new Error(`agent ${spec.name} depends on unknown agent ${dep}`);
      if (dep === spec.name) throw new Error(`agent ${spec.name} depends on itself`);
    }
  }
  // Reject cycles before anything is created.
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`dependency cycle through agent ${name}`);
    visiting.add(name);
    for (const dep of specs.find((spec) => spec.name === name)?.dependsOn ?? []) visit(dep);
    visiting.delete(name);
    done.add(name);
  };
  for (const spec of specs) visit(spec.name);
  return specs;
};

const composeTask = (spec: AgentSpec, results: Map<string, AgentResult>) => {
  const parts = [spec.task];
  for (const dep of spec.dependsOn) {
    const result = results.get(dep);
    if (!result) continue;
    parts.push(`## Result from agent ${dep} (${result.status})\n${clip(result.text || "(no answer)", MAX_ANSWER_CHARS)}`);
  }
  parts.push(
    "Reply with the result of your task only. You work in the same workspace as the calling agent; do not ask questions.",
  );
  return parts.join("\n\n");
};

let subagentsExtension: any;

const subagentTool = defineTool({
  name: "subagent",
  description:
    "Delegate work to child agents that run in the same workspace. Every agent gets its own conversation, model and tools. " +
    "Agents without depends_on start at once; an agent with depends_on starts after those agents finish and receives their answers. " +
    "Returns each agent's answer. Use it for independent or parallel pieces of a request.",
  replay: "safe",
  parameters: obj({
    agents: arr(
      obj({
        name: opt(str()),
        task: str(),
        depends_on: opt(arr(str())),
      }),
      { minItems: 1, maxItems: MAX_AGENTS },
    ),
  }),
  execute: async (args: any, api: any, context: any) => {
    const harness = harnessRef;
    if (!harness) throw new Error("subagents are not available in this session");
    const specs = parseSpecs(args.agents);
    const created: string[] = await api.commit(async (tx: any) => {
      // A replay after a crash finds the children an earlier attempt made.
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, MAX_AGENTS)).items;
      const ids: string[] = [];
      for (let i = 0; i < specs.length; i++) {
        let record = existing[i];
        if (!record) {
          record = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, record.id, { extensions: { remove: [subagentsExtension] }, maxTurns: 40 });
        }
        ids.push(String(record.id));
      }
      return ids;
    }, context);

    for (let i = 0; i < specs.length; i++) {
      hostRecordAgent({
        sessionId,
        conversationId: created[i],
        parentConversationId: String(api.conversationId),
        name: specs[i].name,
        dependsOn: specs[i].dependsOn.join(","),
      });
    }
    await api.details(
      { agents: specs.map((spec, i) => ({ name: spec.name, conversationId: created[i], dependsOn: spec.dependsOn })) },
      context,
    );

    const results = new Map<string, AgentResult>();
    const pending = specs.map((spec) => spec.name);
    while (pending.length > 0) {
      const ready = pending.filter((name) => {
        const spec = specs.find((item) => item.name === name)!;
        return spec.dependsOn.every((dep) => results.has(dep));
      });
      if (ready.length === 0) throw new Error("dependency cycle between subagents");
      await Promise.all(
        ready.map(async (name) => {
          const spec = specs.find((item) => item.name === name)!;
          const conversationId = created[specs.indexOf(spec)];
          const conversation = await harness.conversation(conversationId, context);
          if (!conversation) throw new Error(`subagent ${name} is not available`);
          const tracker = trackConversation(new AgentTracker(conversationId, `subagent:${name}`, String(api.conversationId)));
          tracker.begin();
          try {
            tracker.attach(await conversation.watch(context));
            const submission = await conversation.submit(
              { type: "input", content: composeTask(spec, results), requestId: `subagent:${api.taskId}:${name}` },
              context,
            );
            const settled = await submission.wait(context);
            await yieldToWatch();
            const failure = settled.status === "done" ? undefined : String(settled.reason ?? "unanswered");
            let text = "";
            if (settled.status === "done") {
              const view = await conversation.context(context);
              for (const message of view?.messages ?? []) {
                if (message?.role === "assistant") text = textOf(message);
              }
            }
            tracker.end(failure);
            results.set(name, { status: settled.status, text, conversationId, failure });
          } catch (error: any) {
            tracker.end(String(error?.message ?? error));
            throw error;
          } finally {
            await tracker.stop();
          }
        }),
      );
      for (const name of ready) pending.splice(pending.indexOf(name), 1);
    }

    const lines: string[] = [];
    for (const spec of specs) {
      const result = results.get(spec.name)!;
      const status = result.status === "done" ? "done" : `failed (${result.failure ?? result.status})`;
      lines.push(`## ${spec.name}: ${status}`);
      lines.push(clip(result.text || "(no answer)", MAX_ANSWER_CHARS));
      lines.push("");
    }
    return {
      output: [{ type: "text" as const, text: lines.join("\n").trim() }],
      details: { agents: specs.map((spec) => ({ name: spec.name, ...results.get(spec.name)! })) },
    };
  },
});

let harnessRef: any;

export const createSubagentsExtension = (harness: any) => {
  harnessRef = harness;
  subagentsExtension = defineExtension({ name: "subagents", tools: [subagentTool] });
  return subagentsExtension;
};
