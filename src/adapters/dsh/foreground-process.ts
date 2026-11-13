import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { StreamChunk, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'

/** Display-only metadata, reconstructed from the 55fe runtime event contract. */
export type ForegroundToolActivity = 'read' | 'readImage' | 'search' | 'write' | 'edit' | 'commands' | 'code' | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'
export interface DshForegroundProcessGroup {
  id: string
  turnId: string
  startedAt: number
  closed: boolean
  activity: 'thinking' | ForegroundToolActivity
  preparing?: boolean
  counts: Array<{ kind: ForegroundToolActivity; count: number }>
  endReason?: string
  beforeMessageId?: string
}
interface ProcessNode {
  key: string; turn: number; step: number; order: number; time: number
  kind: 'reasoning' | 'response' | 'tool'
  tentative?: boolean; name?: string; phase?: 'preparing' | 'running' | 'settled'
  sendId?: string; messageId?: string; parentCallId?: string
}
interface StreamAttempt {
  id: string; turn: number; step: number; nextIndex: number
  baseline: Map<string, ProcessNode>
  blocks: Map<number, { kind: ProcessNode['kind']; visible: boolean }>
}
type ProcessSessionEvent = SessionEvent | {
  type: 'llm/retry'; seq: number; time: number; data: { turn: number; step: number }
}

import { isAppendSurfaceEvent, type SessionEvent } from "@deepseek-ai/dsh-session";
import { expandAssistantStream } from "@deepseek-ai/dsh-llm/assistant-stream";
export function foregroundToolActivity(name: string): ForegroundToolActivity {
  if (name === "read") return "read";
  if (name === "read_image") return "readImage";
  if (name === "grep" || name === "glob" || name.endsWith("_inspect")) return "search";
  if (name === "write") return "write";
  if (name === "edit" || name === "apply_patch") return "edit";
  if (["bash", "pwsh", "exec_command", "write_stdin"].includes(name) || name.startsWith("terminal_")) return "commands";
  if (name === "run_code") return "code";
  if (name === "web_search") return "webSearch";
  if (name === "web_fetch") return "webFetch";
  if (name === "subagent" || name.startsWith("subagent_")) return "subagents";
  if (["todo_write", "create_goal", "update_goal", "get_goal"].includes(name)) return "plan";
  if (name === "ask_user_question" || name === "request_user_input") return "questions";
  return "tools";
}
const textPresent = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
function conversationSendSucceeded(result: Pick<ToolResultMessage, 'isError' | 'content'>): boolean {
  if (result.isError) return false;
  for (const block of result.content) if (block.type === "text") {
    try {
      const value = JSON.parse(block.text);
      if (value && typeof value === "object" && "sent" in value && value.sent === false) return false;
    } catch {
    }
  }
  return true;
}
export class DshForegroundProcessTracker {
  constructor(readonly sessionId: string, events: readonly ProcessSessionEvent[] = []) {
    for (const event of events) this.acceptSession(event);
  }
  private nodes = new Map<string, ProcessNode>();
  private ends = new Map<number, string>();
  private currentTurn?: number;
  private currentStep = 0;
  private cursor = -1;
  private transient = 0;
  private attempt?: StreamAttempt;
  private value: DshForegroundProcessGroup[] = [];
  private durableValue: DshForegroundProcessGroup[] = [];
  snapshot(): readonly DshForegroundProcessGroup[] {
    return this.value;
  }
  /** Closed live groups may still belong to an abandoned attempt. Persist only this view. */
  durableSnapshot(): readonly DshForegroundProcessGroup[] {
    return this.durableValue;
  }
  private put(node: ProcessNode): void {
    const previous = this.nodes.get(node.key);
    this.nodes.set(node.key, previous ? { ...node, order: previous.order, time: previous.time } : node);
  }
  private assistant(turn: number, step: number, kind: 'reasoning' | 'response', present: boolean, order: number, time: number, tentative = false): void {
    const key = `assistant:${turn}:${step}:${kind}`;
    if (!present) {
      this.nodes.delete(key);
      return;
    }
    const sibling = this.nodes.get(`assistant:${turn}:${step}:${kind === "reasoning" ? "response" : "reasoning"}`);
    this.put({ key, turn, step, kind: kind, order: sibling?.order ?? order, time: sibling?.time ?? time, ...tentative ? { tentative: true } : {} });
  }
  private discardAttempt(): void {
    if (!this.attempt) return;
    this.nodes = this.attempt.baseline;
    this.attempt = void 0;
  }
  acceptStream(frame: AssistantStreamFrame): boolean {
    if (frame.type === "start") {
      this.discardAttempt();
      this.attempt = { id: String(frame.attemptId), turn: frame.turn, step: frame.step, nextIndex: 0, baseline: new Map(this.nodes), blocks: /* @__PURE__ */ new Map() };
      return this.rebuild();
    }
    const attempt = this.attempt;
    if (!attempt || attempt.id !== String(frame.attemptId)) return false;
    if (frame.index !== attempt.nextIndex) {
      this.discardAttempt();
      return this.rebuild();
    }
    if (frame.type === "end") {
      if (frame.outcome.kind === "abandoned") this.discardAttempt();
      else this.attempt = void 0;
      return this.rebuild();
    }
    attempt.nextIndex++;
    const order = this.cursor + 1 - 1 / (++this.transient + 1);
    if (this.ends.has(attempt.turn)) return false;
    this.applyChunk(attempt, frame.chunk, order, frame.time, true);
    return this.rebuild();
  }
  private applyChunk(attempt: StreamAttempt, chunk: StreamChunk, order: number, time: number, tentative: boolean): void {
    const { turn, step } = attempt;
    if (chunk.type === "block-start") attempt.blocks.set(chunk.index, { kind: chunk.blockType === "reasoning" ? "reasoning" : chunk.blockType === "tool-call" ? "tool" : "response", visible: chunk.blockType !== "reasoning" && chunk.blockType !== "text" && chunk.blockType !== "tool-call" });
    if (chunk.type === "reasoning-delta" || chunk.type === "text-delta")
      attempt.blocks.set(chunk.index, { kind: chunk.type === "reasoning-delta" ? "reasoning" : "response", visible: attempt.blocks.get(chunk.index)?.visible === true || textPresent(chunk.text) });
    if (chunk.type === "tool-call-delta") {
      const key = `tool:${String(chunk.id)}`, previous = this.nodes.get(key), name = chunk.name ?? previous?.name;
      if (name && previous?.phase !== "running" && previous?.phase !== "settled")
        this.put({ key, turn, step, order, time, kind: "tool", name: name, phase: "preparing", ...tentative ? { tentative: true } : {} });
    }
    if (chunk.type === "block-end") {
      const block = chunk.block;
      attempt.blocks.set(chunk.index, {
        kind: block.type === "reasoning" ? "reasoning" : block.type === "tool-call" ? "tool" : "response",
        visible: block.type === "reasoning" || block.type === "text" ? textPresent(block.text) : block.type !== "tool-call"
      });
    }
    for (const kind of ["reasoning", "response"] as const)
      this.assistant(turn, step, kind, [...attempt.blocks.values()].some((block) => block.kind === kind && block.visible), order, time, tentative);
  }
  acceptSession(event: ProcessSessionEvent): boolean {
    this.cursor = Math.max(this.cursor, event.seq);
    this.transient = 0;
    if (event.type === "turn/start") {
      this.currentTurn = event.data.turn;
      this.currentStep = 0;
    }
    if (event.type === "step/start") {
      this.currentTurn = event.data.turn;
      this.currentStep = event.data.step;
    }
    if (event.type === "llm/retry") {
      const retry = event;
      this.discardAttempt();
      for (const [key, node] of this.nodes) if (node.turn === retry.data.turn && node.step === retry.data.step && node.tentative) this.nodes.delete(key);
    }
    if (event.type === "assistant/message" && isAppendSurfaceEvent(event)) {
      const { turn, step, message } = event.data;
      const blocks = message.content;
      const replay: StreamAttempt = { id: "", turn, step, nextIndex: 0, baseline: /* @__PURE__ */ new Map(), blocks: /* @__PURE__ */ new Map() };
      const stream = expandAssistantStream(event.data.stream ?? []);
      for (let index = 0; index < stream.length; index++) {
        const member = stream[index];
        this.applyChunk(replay, member.chunk, event.seq - 1 + (index + 1) / (stream.length + 1), member.time, false);
      }
      this.assistant(turn, step, "reasoning", blocks.some((block) => block.type === "reasoning" && textPresent(block.text)), event.seq, event.time);
      this.assistant(turn, step, "response", blocks.some((block) => block.type !== "reasoning" && block.type !== "tool-call" && (block.type !== "text" || textPresent(block.text))), event.seq, event.time);
      if (event.data.interrupted) {
        for (const [key, node] of this.nodes)
          if (node.turn === turn && node.step === step && node.phase === "preparing") this.nodes.delete(key);
      }
      if (this.attempt?.turn === turn && this.attempt.step === step) this.attempt.baseline = new Map(this.nodes);
    }
    if (event.type === "assistant/attempt") this.discardAttempt();
    if (event.type === "tool/call") {
      const { turn, step, callId, name: name } = event.data;
      let sendId;
      if (name === "dss_conversation_send") try {
        const input = JSON.parse(event.data.arguments);
        if (typeof input.id === "string" && textPresent(input.text)) sendId = input.id;
      } catch {
      }
      this.put({ key: `tool:${String(callId)}`, turn, step, order: event.seq, time: event.time, kind: "tool", name: name, phase: "running", ...sendId ? { sendId } : {} });
    }
    if (event.type === "tool/result" && isAppendSurfaceEvent(event)) {
      const key = `tool:${String(event.data.message.source.callId)}`, node = this.nodes.get(key);
      if (node) {
        this.nodes.set(key, { ...node, phase: "settled" });
        if (node.sendId && conversationSendSucceeded(event.data.message)) this.response(node.sendId, node.turn, node.step, event.seq, event.time);
      }
    }
    if (event.type === "tool/ptc-dispatch-start" || event.type === "tool/ptc-dispatch") {
      const data = event.data, root = this.nodes.get(`tool:${String(data.rootCallId)}`), key = `tool:${String(data.subCallId)}`;
      if (root && String(data.subCallId) !== String(data.rootCallId)) {
        this.put({
          key,
          turn: root.turn,
          step: root.step,
          order: root.order,
          time: event.time,
          kind: "tool",
          name: data.name,
          parentCallId: String(data.parentCallId),
          phase: event.type === "tool/ptc-dispatch-start" ? "running" : "settled"
        });
        const input = data.arguments as { id?: unknown; text?: unknown } | null;
        if (event.type === "tool/ptc-dispatch" && conversationSendSucceeded(event.data) && data.name === "dss_conversation_send" && input && typeof input.id === "string" && textPresent(input.text))
          this.response(input.id, root.turn, root.step, event.seq, event.time);
      }
    }
    if (event.type === "step/end") {
      for (const [key, node] of this.nodes)
        if (node.turn === event.data.turn && node.step === event.data.step && node.phase === "preparing") this.nodes.delete(key);
    }
    if (event.type === "turn/end") {
      this.ends.set(event.data.turn, event.data.reason.kind);
      this.attempt = void 0;
    }
    return this.rebuild();
  }
  private response(messageId: string, turn: number, step: number, order: number, time: number): void {
    this.put({ key: `response:${messageId}`, turn, step, order, time, kind: "response", messageId });
  }
  /** Called only after the existing dss_conversation_send commit succeeds. */
  reply(messageId: string): boolean {
    if (this.currentTurn === void 0) return false;
    this.response(messageId, this.currentTurn, this.currentStep, this.cursor + 0.99, Date.now());
    return this.rebuild();
  }
  private turnId(turn: number): string {
    return JSON.stringify([this.sessionId, turn]);
  }
  private groupsFor(input: Iterable<ProcessNode>): DshForegroundProcessGroup[] {
    const groups: DshForegroundProcessGroup[] = [];
    const nodes = [...input].sort((a, b) => a.order - b.order || (a.kind === "reasoning" ? -1 : b.kind === "reasoning" ? 1 : 0));
    let pending: ProcessNode[] = [], turn: number | undefined;
    const flush = (closed: boolean, messageId?: string) => {
      const first = pending[0];
      if (!first) return;
      const id = JSON.stringify([this.sessionId, first.turn, first.key]), counts = new Map<ForegroundToolActivity, number>();
      let running: ProcessNode | undefined;
      for (const node of pending) if (node.kind === "tool") {
        const category = foregroundToolActivity(node.name ?? "");
        counts.set(category, (counts.get(category) ?? 0) + 1);
        if (node.phase !== "settled" && (!running || node.time >= running.time)) running = node;
      }
      const ended = this.ends.get(first.turn), done = closed || ended !== void 0;
      const beforeMessageId = messageId;
      groups.push({
        id,
        turnId: this.turnId(first.turn),
        startedAt: first.time,
        closed: done,
        activity: !done && running ? foregroundToolActivity(running.name ?? "") : "thinking",
        preparing: !done && running?.phase === "preparing",
        counts: [...counts].map(([kind, count]) => ({ kind: kind, count })).sort((a, b) => b.count - a.count),
        ...ended ? { endReason: ended } : {},
        ...beforeMessageId ? { beforeMessageId } : {}
      });
      pending = [];
    };
    for (const node of nodes) {
      if (turn !== void 0 && turn !== node.turn) flush(true);
      turn = node.turn;
      if (node.kind === "response") flush(true, node.messageId);
      else pending.push(node);
    }
    flush(false);
    return groups;
  }
  private rebuild(): boolean {
    const nodes = [...this.nodes.values()];
    const groups = this.groupsFor(nodes);
    const durable = this.groupsFor(nodes.filter((node) => !node.tentative));
    const durableChanged = JSON.stringify(durable) !== JSON.stringify(this.durableValue);
    this.durableValue = durable;
    if (JSON.stringify(groups) === JSON.stringify(this.value)) return durableChanged;
    this.value = groups;
    return true;
  }
}
