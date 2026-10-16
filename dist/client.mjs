// src/main.ts
import { readFile as readFile2, mkdir as mkdir2, writeFile as writeFile2, rename as rename2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2, resolve as resolve2 } from "node:path";
import { parseArgs } from "node:util";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { AttachmentChipsBand } from "@oh-my-pi/pi-tui/prompt/attachment-chips";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { Text as Text6 } from "@oh-my-pi/pi-tui/components/text";
import { ErrorBannerComponent } from "@oh-my-pi/pi-tui/overlays/error-banner";
import { EMPTY_NODE as EMPTY_NODE3, node as node4, span as span2 } from "@oh-my-pi/pi-tui/native/describe";
import { TSP_PREFIX } from "@oh-my-pi/pi-tui/native/encode";
import { actionButton as actionButton2 } from "@oh-my-pi/pi-tui/native/overlay";
import { onNativeRenderingChange } from "@oh-my-pi/pi-tui/native/state";
import { stopSharedSpinnerTicker } from "@oh-my-pi/pi-tui/chat/tool-execution";

// src/backend.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import {
  AutonomyLevel,
  DroidClient,
  ProcessTransport,
  ReasoningEffort,
  DroidInteractionMode,
  ToolConfirmationOutcome,
  ContextBreakdownResultSchema,
  listSessions,
  resolveExecCoreDeps
} from "@factory/droid-sdk/node";

// src/session-lock.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
var SessionLockError = class extends Error {
};
function isErrno(error) {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string";
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error) || error.code !== "ESRCH";
  }
}
async function owner(path) {
  try {
    const value = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
    if (value && typeof value === "object" && "pid" in value && "token" in value && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === "string") return { pid: value.pid, token: value.token };
  } catch {
  }
  return null;
}
var SessionLock = class _SessionLock {
  constructor(path, token) {
    this.path = path;
    this.token = token;
  }
  released = false;
  static async acquire(dataDir, sessionId) {
    const root = join(dataDir, "session-locks");
    await mkdir(root, { recursive: true, mode: 448 });
    const path = join(root, `${createHash("sha256").update(sessionId).digest("hex")}.lock`);
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(path, { mode: 448 });
        await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 384 });
        return new _SessionLock(path, token);
      } catch (error) {
        if (!isErrno(error) || error.code !== "EEXIST") throw new SessionLockError("Cannot create the session lock. Check the plugin data directory permissions.");
      }
      const gate = join(path, "reclaim");
      try {
        await mkdir(gate, { mode: 448 });
      } catch {
        throw new SessionLockError("Another plugin process is opening this session. Close that instance before resuming.");
      }
      let moved = false;
      try {
        const current = await owner(path);
        if (!current || alive(current.pid)) {
          throw new SessionLockError(current ? `This session is owned by plugin process ${current.pid}. Close it before resuming here.` : "The session lock has no verifiable owner. Confirm all plugin instances are closed before removing its lock in the plugin data directory.");
        }
        const retired = `${path}.retired-${token}`;
        await rename(path, retired);
        moved = true;
        await rm(retired, { recursive: true, force: true });
      } finally {
        if (!moved) await rm(gate, { recursive: true, force: true });
      }
    }
    throw new SessionLockError("The session lock changed while opening. Choose the session again.");
  }
  async release() {
    if (this.released) return;
    this.released = true;
    if ((await owner(this.path))?.token === this.token) await rm(this.path, { recursive: true, force: true });
  }
};

// src/transcript.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    const block = record(item);
    if (block.type === "text") return typeof block.text === "string" ? block.text : "";
    if (block.type === "document") {
      const source = record(block.source);
      if (source.type === "text") return typeof source.data === "string" ? source.data : "";
      return typeof source.parsedData === "string" ? source.parsedData : `[PDF: ${typeof source.name === "string" ? source.name : "attachment"}]`;
    }
    return "";
  }).filter(Boolean).join("\n");
}
var Transcript = class {
  messages = [];
  byId = /* @__PURE__ */ new Map();
  tools = /* @__PURE__ */ new Map();
  finalized = /* @__PURE__ */ new Set();
  completedBlocks = /* @__PURE__ */ new Set();
  partials = /* @__PURE__ */ new Set();
  hydrate(messages) {
    this.messages.length = 0;
    this.byId.clear();
    this.tools.clear();
    this.finalized.clear();
    this.completedBlocks.clear();
    this.partials.clear();
    if (Array.isArray(messages)) for (const message of messages) this.upsert(message);
    this.finish("interrupted");
  }
  upsert(value) {
    const raw = record(value);
    if (typeof raw.id !== "string" || !Array.isArray(raw.content)) return;
    const hidden = raw.visibility === "llm_only" || raw.isUserVisible === false || raw.hiddenFromUserViews === true;
    const role = raw.role === "user" || raw.role === "assistant" ? raw.role : "system";
    const message = this.byId.get(raw.id) ?? { id: raw.id, role, blocks: [] };
    message.role = role;
    this.partials.delete(message);
    delete message.streaming;
    const blocks = [];
    raw.content.forEach((value2, index) => {
      const block = record(value2);
      const id = `${raw.id}:${index}`;
      if (block.type === "tool_result" && typeof block.toolUseId === "string") {
        this.result(block.toolUseId, block.content, block.isError === true, raw.id);
      } else if (!hidden && block.type === "tool_use" && typeof block.id === "string") {
        const tool = this.tool(block.id, typeof block.name === "string" ? block.name : "Tool");
        tool.block.args = JSON.stringify(block.input ?? {}, null, 2);
        if (tool.owner && tool.owner !== message && tool.owner.id === tool.resultMessageId) this.remove(tool.owner.id);
        tool.owner = message;
        blocks.push(tool.block, ...tool.images);
      } else if (!hidden && block.type === "text" && typeof block.text === "string") {
        blocks.push({ id, kind: "text", text: block.text });
      } else if (!hidden && block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        blocks.push({ id, kind: "thinking", text: block.thinking });
      } else if (!hidden && block.type === "image") {
        const source = record(block.source);
        if (typeof source.data === "string" && typeof source.mediaType === "string") blocks.push({ id, kind: "image", data: source.data, mime: source.mediaType });
      } else if (!hidden && block.type === "document") {
        const source = record(block.source);
        blocks.push({ id, kind: "text", text: textContent([block]) || `[PDF: ${typeof source.name === "string" ? source.name : "attachment"}]` });
      }
    });
    if (!hidden && blocks.length) {
      message.blocks = blocks;
      if (!this.byId.has(raw.id)) {
        this.byId.set(raw.id, message);
        this.messages.push(message);
      }
    } else if (hidden) {
      this.remove(raw.id);
    }
    this.finalized.add(raw.id);
  }
  apply(value) {
    const event = record(value);
    if (event.type === "create_message") {
      this.upsert(event.message);
      return;
    }
    if (event.type === "assistant_message_retracted" && typeof event.messageId === "string") {
      this.remove(event.messageId);
      return;
    }
    if ((event.type === "assistant_text_delta" || event.type === "thinking_text_delta") && typeof event.messageId === "string" && typeof event.blockIndex === "number" && typeof event.textDelta === "string") {
      const id = `${event.messageId}:${event.blockIndex}`;
      if (this.finalized.has(event.messageId) || this.completedBlocks.has(id)) return;
      let message = this.byId.get(event.messageId);
      if (!message) {
        message = { id: event.messageId, role: "assistant", blocks: [] };
        this.byId.set(message.id, message);
        this.messages.push(message);
      }
      message.streaming = true;
      this.partials.add(message);
      let block = message.blocks.find((item) => item.id === id);
      if (!block) {
        block = { id, kind: event.type === "thinking_text_delta" ? "thinking" : "text", text: "" };
        message.blocks.push(block);
        message.blocks.sort((a, b) => Number(a.id.slice(a.id.lastIndexOf(":") + 1)) - Number(b.id.slice(b.id.lastIndexOf(":") + 1)));
      }
      if (block.kind === "text" || block.kind === "thinking") block.text += event.textDelta;
    } else if ((event.type === "assistant_text_complete" || event.type === "thinking_text_complete") && typeof event.messageId === "string") {
      this.completedBlocks.add(`${event.messageId}:${event.blockIndex}`);
      const message = this.byId.get(event.messageId);
      if (message && this.partials.has(message) && message.blocks.every((block) => block.kind !== "text" && block.kind !== "thinking" || this.completedBlocks.has(block.id))) message.streaming = false;
    } else if (event.type === "tool_call") {
      const use = record(event.toolUse);
      if (typeof use.id === "string") {
        const tool = this.tool(use.id, typeof use.name === "string" ? use.name : "Tool");
        tool.block.args = JSON.stringify(use.input ?? {}, null, 2);
      }
    } else if (event.type === "tool_result" && typeof event.toolUseId === "string") {
      this.result(event.toolUseId, event.content, event.isError === true, typeof event.messageId === "string" ? event.messageId : void 0);
    } else if (event.type === "tool_progress_update" && typeof event.toolUseId === "string") {
      const tool = this.tool(event.toolUseId, typeof event.toolName === "string" ? event.toolName : "Tool").block;
      const update = record(event.update);
      if (typeof update.fullOutput === "string") tool.output = update.fullOutput;
      else if (typeof update.text === "string") tool.output += update.text;
      else if (typeof update.details === "string") tool.output = update.details;
      else if (typeof update.valueSnippet === "string") tool.output = update.valueSnippet;
      else if (typeof update.status === "string") tool.output = update.status;
      if (typeof update.error === "string") {
        tool.output = update.error;
        tool.status = "error";
      }
      if (update.type === "tool_result") tool.status = "done";
    } else if (event.type === "tool_execution_phase_changed" && typeof event.toolUseId === "string") {
      const tool = this.tool(event.toolUseId, typeof event.toolName === "string" ? event.toolName : "Tool").block;
      if (event.phase === "executing" || event.phase === "streaming_input" || event.phase === "queued") tool.status = "running";
      else if (event.phase === "settled_without_execution" && tool.status === "running") tool.status = "interrupted";
    }
  }
  finish(status) {
    for (const message of this.partials) delete message.streaming;
    this.partials.clear();
    for (const tool of this.tools.values()) {
      if (tool.block.status === "running") tool.block.status = status;
      if (!tool.owner && tool.resultMessageId) {
        let message = this.byId.get(tool.resultMessageId);
        if (!message) {
          message = { id: tool.resultMessageId, role: "system", blocks: [] };
          this.byId.set(message.id, message);
          this.messages.push(message);
        }
        message.blocks.push(tool.block, ...tool.images);
        tool.owner = message;
      }
    }
  }
  tool(id, name) {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = { block: { id, kind: "tool", name, args: "", output: "", status: "running" }, images: [] };
      this.tools.set(id, tool);
    } else if (name !== "Tool") tool.block.name = name;
    return tool;
  }
  result(id, content, isError, messageId) {
    const tool = this.tool(id, "Tool");
    if (content !== void 0) tool.block.output = textContent(content);
    tool.block.status = isError ? "error" : "done";
    tool.block.resultReceived = true;
    if (messageId) tool.resultMessageId = messageId;
    if (Array.isArray(content)) {
      tool.images = content.flatMap((value, index) => {
        const block = record(value);
        const source = record(block.source);
        return block.type === "image" && typeof source.data === "string" && typeof source.mediaType === "string" ? [{ id: `${id}:result:${index}`, kind: "image", data: source.data, mime: source.mediaType }] : [];
      });
      if (tool.owner) {
        tool.owner.blocks = tool.owner.blocks.filter((block) => !block.id.startsWith(`${id}:result:`));
        tool.owner.blocks.push(...tool.images);
      }
    }
  }
  remove(id) {
    const index = this.messages.findIndex((message2) => message2.id === id);
    const message = this.byId.get(id);
    if (message) this.partials.delete(message);
    if (index >= 0) this.messages.splice(index, 1);
    this.byId.delete(id);
    this.finalized.add(id);
  }
};

// src/backend.ts
var runtime = {
  create(options) {
    const deps = resolveExecCoreDeps(void 0);
    const transport = new ProcessTransport({
      droidExecPath: options.execPath,
      cwd: options.cwd,
      env: { FACTORY_DROID_SDK_TRANSPORT_LOG: "0" }
    }, { ...deps, environmentResolver: { ...deps.environmentResolver, resolveTransportLogEnvValue: () => void 0 } });
    const client = new DroidClient({ transport });
    return { client, connect: () => transport.connect() };
  },
  listSessions
};
var BridgeFailure = class extends Error {
};
function failure(error, action) {
  if (error instanceof BridgeFailure || error instanceof SessionLockError) return new BridgeFailure(error.message);
  const name = error instanceof Error ? error.name : "";
  const metadata = record(record(error).metadata);
  const code2 = record(error).code ?? metadata.code;
  if (code2 === "ENOENT" || metadata.message === "executable not found") return new BridgeFailure(`${action}: Droid could not start. Check the executable path and working directory.`);
  if (code2 === -32004 || name === "SessionNotFoundError") return new BridgeFailure(`${action}: the saved session was not found. Choose another session.`);
  if (name === "TimeoutError") return new BridgeFailure(`${action}: Droid did not confirm the request in time. Nothing was resubmitted; inspect the session before sending again.`);
  if (name === "ConnectionError" || name === "ProcessExitError") return new BridgeFailure(`${action}: the Droid connection ended. No prompt was replayed. Reopen the saved session after checking Droid CLI login and executable access.`);
  if (name === "ProtocolError") return new BridgeFailure(`${action}: Droid rejected the request${typeof code2 === "number" ? ` (code ${code2})` : ""}. Check the selected session, model and CLI login.`);
  return new BridgeFailure(`${action}: Droid could not complete the operation. Check CLI login, executable access and session availability. No request was automatically retried.`);
}
function result(response) {
  const envelope = record(response);
  if (envelope.error) {
    const code2 = record(envelope.error).code;
    throw new BridgeFailure(`Droid rejected the request${typeof code2 === "number" ? ` (code ${code2})` : ""}. Check session availability and the current settings.`);
  }
  if (!envelope.result || typeof envelope.result !== "object") throw new BridgeFailure("Droid returned no confirmed result. Check that the CLI supports the installed SDK.");
  return record(envelope.result);
}
function normalizeModels(value, selected, previous = []) {
  const models = /* @__PURE__ */ new Map();
  if (Array.isArray(value)) for (const item of value) {
    const model = record(item);
    if (typeof model.id !== "string" || model.disabled === true) continue;
    const noImageSupport = typeof model.noImageSupport === "boolean" ? model.noImageSupport : (models.get(model.id) ?? previous.find((item2) => item2.id === model.id))?.noImageSupport;
    models.set(model.id, {
      id: model.id,
      label: typeof model.displayName === "string" ? model.displayName : model.id,
      reasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.filter((effort) => typeof effort === "string") : [],
      ...typeof model.defaultReasoningEffort === "string" ? { defaultReasoningEffort: model.defaultReasoningEffort } : {},
      ...noImageSupport !== void 0 ? { noImageSupport } : {}
    });
  }
  if (selected?.modelId && !models.has(selected.modelId)) models.set(selected.modelId, previous.find((model) => model.id === selected.modelId) ?? { id: selected.modelId, label: selected.modelId, reasoningEfforts: selected.reasoningEffort ? [selected.reasoningEffort] : [] });
  return [...models.values()];
}
function settings(value, previous) {
  const source = record(value);
  return {
    modelId: typeof source.modelId === "string" ? source.modelId : previous?.modelId ?? "",
    reasoningEffort: typeof source.reasoningEffort === "string" ? source.reasoningEffort : previous?.reasoningEffort ?? "",
    autonomyLevel: typeof source.autonomyLevel === "string" ? source.autonomyLevel : previous?.autonomyLevel ?? "",
    interactionMode: typeof source.interactionMode === "string" ? source.interactionMode : previous?.interactionMode ?? "",
    ...Array.isArray(source.availableAutonomyLevels) ? { availableAutonomyLevels: source.availableAutonomyLevels.filter((level) => typeof level === "string" && Object.values(AutonomyLevel).includes(level)) } : previous?.availableAutonomyLevels !== void 0 ? { availableAutonomyLevels: previous.availableAutonomyLevels } : {}
  };
}
function imageSources(images) {
  if (images === void 0) return void 0;
  const invalid = "Image attachments must contain valid base64 data in JPEG, PNG, GIF or WebP format.";
  if (!Array.isArray(images)) throw new BridgeFailure(invalid);
  const sources = [];
  for (const image of images) {
    const { data, mimeType } = record(image);
    if (typeof data !== "string" || !data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/gif" && mimeType !== "image/webp") throw new BridgeFailure(invalid);
    sources.push(Object.freeze({ type: "base64", data, mediaType: mimeType }));
  }
  Object.freeze(sources);
  return sources;
}
var PENDING_SNAPSHOT_NOTICE = "Droid reported a pending prompt without reissuing its live request. This session is read-only until a live request arrives or Stop confirms idle. Otherwise answer it in its original owner and reopen the session.";
var DroidBridge = class {
  constructor(options, sdk = runtime) {
    this.options = options;
    this.sdk = sdk;
  }
  state = {
    phase: "disconnected",
    session: null,
    messages: [],
    models: [],
    approval: null,
    question: null,
    error: null,
    notice: null,
    context: null,
    usage: null,
    needsInterrupt: false,
    workingState: null
  };
  scope = null;
  transcript = new Transcript();
  active = null;
  operation = null;
  prepared = null;
  async open(sessionId) {
    if (this.operation) throw new BridgeFailure("A session operation is already in progress. Wait for it to finish.");
    const token = Symbol();
    this.operation = token;
    try {
      const previous = this.scope;
      this.scope = null;
      this.cancelTurn(previous, "Session changed. The previous prompt was not replayed.");
      if (previous) await this.dispose(previous);
      if (this.operation !== token) throw new BridgeFailure("Session opening was cancelled.");
      this.state.phase = "connecting";
      this.state.error = null;
      this.state.notice = null;
      this.state.workingState = null;
      this.changed();
      await this.connect(sessionId);
    } catch (error) {
      const problem = failure(error, "Open session");
      if (this.operation === token) {
        this.state.phase = "error";
        this.state.error = problem.message;
        this.changed();
      }
      throw problem;
    } finally {
      if (this.operation === token) this.operation = null;
    }
  }
  async sessions(all) {
    try {
      const entries = await this.sdk.listSessions({ cwd: this.options.cwd, fetchOutsideCWD: all });
      return entries.map((entry) => ({ id: entry.id, title: entry.title, cwd: entry.cwd, modifiedTime: entry.modifiedTime.toISOString() }));
    } catch (error) {
      throw this.report(error, "List sessions");
    }
  }
  async contextDetails() {
    const scope = this.ready();
    const revision = scope.revision;
    try {
      const response = result(await scope.client.getContextBreakdown());
      if (this.scope !== scope || scope.revision !== revision) throw new BridgeFailure("The session changed while reading context usage.");
      const parsed = ContextBreakdownResultSchema.safeParse(response);
      if (!parsed.success) throw new BridgeFailure("Droid did not return a supported context breakdown. Check the CLI version.");
      return parsed.data;
    } catch (error) {
      throw failure(error, "Read context usage");
    }
  }
  async send(text2, onAccepted, images) {
    const scope = this.ready();
    const sources = imageSources(images);
    if (!text2.trim() && !sources?.length) throw new BridgeFailure("Enter a message or attach an image before sending.");
    if (this.active || this.operation || this.state.phase !== "idle") throw new BridgeFailure("Droid already has active work. Stop it or wait before sending another message.");
    if (scope.unansweredSnapshots.size) throw new BridgeFailure(PENDING_SNAPSHOT_NOTICE);
    if (sources?.length && this.state.models.find((model) => model.id === this.state.session?.settings.modelId)?.noImageSupport === true) {
      throw new BridgeFailure("The selected Droid model does not support image attachments. Choose an image-capable model or remove the images.");
    }
    const { promise: done, resolve: resolveDone, reject: rejectDone } = Promise.withResolvers();
    void done.catch(() => void 0);
    const turn = {
      scope,
      requestId: randomUUID2(),
      messageId: randomUUID2(),
      accepted: false,
      accept: onAccepted,
      completed: false,
      settle(error) {
        if (turn.completed) return;
        turn.completed = true;
        if (error) rejectDone(error);
        else resolveDone();
      }
    };
    this.active = turn;
    this.prepared = null;
    scope.remoteBusy = true;
    this.state.workingState = null;
    this.state.error = null;
    this.state.notice = null;
    this.state.phase = "running";
    this.changed();
    try {
      await Promise.race([
        scope.client.addUserMessage({ text: text2, messageId: turn.messageId, ...sources?.length ? { images: sources } : {} }, turn.requestId).then(result),
        done
      ]);
      await done;
    } catch (error) {
      const problem = failure(error, "Send message");
      turn.settle(problem);
      if (this.scope === scope && this.active === turn) {
        this.transcript.finish("error");
        this.state.phase = "error";
        this.state.error = problem.message;
        this.cancelPrompts(scope);
        this.changed();
      }
      throw problem;
    } finally {
      if (this.active === turn) this.active = null;
    }
  }
  async interrupt() {
    const scope = this.ready();
    this.cancelPrompts(scope);
    if (!this.active && this.state.phase === "idle") {
      this.changed();
      return;
    }
    scope.stopping = true;
    this.state.phase = "stopping";
    this.changed();
    try {
      result(await scope.client.interruptSession());
    } catch (error) {
      throw this.report(error, "Stop Droid");
    }
  }
  resolveApproval(requestId, value, editedSpecContent) {
    const scope = this.scope;
    const prompt = scope?.prompts[0];
    if (!scope || !prompt || prompt.kind !== "approval" || prompt.id !== requestId) return;
    if (!prompt.view.options.some((option) => option.value === value)) {
      this.state.error = "Choose one of the permission outcomes actually offered by Droid.";
      this.changed();
      return;
    }
    if (value === ToolConfirmationOutcome.ProceedEdit && !editedSpecContent?.trim()) {
      this.state.error = "An edited plan is required for this outcome. Edit the plan or choose another offered outcome.";
      this.changed();
      return;
    }
    scope.prompts.shift();
    const disabledReason = prompt.view.options.find((option) => option.value === value)?.disabledReason;
    if (disabledReason) {
      scope.prompts.unshift(prompt);
      this.state.error = disabledReason;
      this.changed();
      return;
    }
    prompt.settle({ selectedOption: value, ...value === ToolConfirmationOutcome.ProceedEdit ? { editedSpecContent } : {} });
    this.state.error = null;
    this.showPrompt(scope);
  }
  resolveQuestion(requestId, answers) {
    const scope = this.scope;
    const prompt = scope?.prompts[0];
    if (!scope || !prompt || prompt.kind !== "question" || prompt.id !== requestId) return;
    if (answers && (answers.length !== prompt.view.questions.length || new Set(answers.map((item) => item.index)).size !== answers.length || prompt.view.questions.some((question) => !answers.some((answer) => answer.index === question.index && answer.question === question.question && answer.answer.trim())))) {
      this.state.error = "Answer every current question, or cancel the questionnaire.";
      this.changed();
      return;
    }
    scope.prompts.shift();
    prompt.settle(answers ? { answers } : { cancelled: true, answers: [] });
    this.state.error = null;
    this.showPrompt(scope);
  }
  async updateSettings(patch) {
    if (patch.autonomyLevel !== void 0) {
      const allowed = this.state.session?.settings.availableAutonomyLevels;
      if (!Object.values(AutonomyLevel).includes(patch.autonomyLevel) || allowed && !allowed.includes(patch.autonomyLevel)) {
        throw new BridgeFailure("This autonomy level is not available under the current Droid policy.");
      }
    }
    await this.mutate("Update settings", async (scope) => {
      if (patch.reasoningEffort !== void 0 && !Object.values(ReasoningEffort).includes(patch.reasoningEffort)) throw new BridgeFailure("The requested reasoning effort is not supported by the SDK.");
      if (patch.interactionMode !== void 0 && !Object.values(DroidInteractionMode).includes(patch.interactionMode)) throw new BridgeFailure("Choose Auto or Spec mode.");
      result(await scope.client.updateSessionSettings({ ...patch, reasoningEffort: patch.reasoningEffort, autonomyLevel: patch.autonomyLevel, interactionMode: patch.interactionMode }, randomUUID2()));
      await this.reload(scope);
      const actual = this.state.session?.settings;
      for (const key of Object.keys(patch)) {
        if (patch[key] !== void 0 && actual?.[key] !== patch[key]) throw new BridgeFailure("Droid did not confirm every requested setting. The displayed settings are the values actually returned by Droid.");
      }
    });
  }
  async rename(title) {
    await this.mutate("Rename session", async (scope) => {
      if (!title.trim()) throw new BridgeFailure("Enter a non-empty session title.");
      result(await scope.client.renameSession({ title: title.trim() }, randomUUID2()));
      await this.reload(scope);
    });
  }
  async fork() {
    await this.mutate("Fork session", async (scope) => {
      const response = result(await scope.client.forkSession({}));
      await this.replace(scope, response.newSessionId);
    });
  }
  async compact(instructions) {
    await this.mutate("Compact session", async (scope) => {
      const response = result(await scope.client.compactSession(instructions?.trim() ? { customInstructions: instructions } : {}));
      await this.replace(scope, response.newSessionId);
      this.state.notice = `Droid compacted the conversation${typeof response.removedCount === "number" ? ` (${response.removedCount} messages removed)` : ""}.`;
    });
  }
  async prepareRewind(messageId) {
    let plan;
    await this.mutate("Inspect rewind", async (scope) => {
      if (!this.state.messages.some((message) => message.id === messageId && message.role === "user")) throw new BridgeFailure("Choose a user message in the current session as the rewind target.");
      const info = result(await scope.client.getRewindInfo({ messageId }));
      const restores = Array.isArray(info.availableFiles) ? info.availableFiles : [];
      const deletes = Array.isArray(info.createdFiles) ? info.createdFiles : [];
      plan = {
        messageId,
        filesToRestore: restores.map((value) => {
          const item = record(value);
          if (typeof item.filePath !== "string" || typeof item.contentHash !== "string" || typeof item.size !== "number") throw new BridgeFailure("Droid returned an invalid file rewind plan.");
          return { filePath: item.filePath, contentHash: item.contentHash, size: item.size };
        }),
        filesToDelete: deletes.map((value) => {
          const item = record(value);
          if (typeof item.filePath !== "string") throw new BridgeFailure("Droid returned an invalid deletion plan.");
          return { filePath: item.filePath };
        }),
        unavailable: Array.isArray(info.evictedFiles) ? info.evictedFiles.map((value) => {
          const item = record(value);
          return `${String(item.filePath ?? "")}: ${String(item.reason ?? "Snapshot unavailable")}`;
        }) : []
      };
      this.prepared = { scope, plan: structuredClone(plan) };
    });
    return plan;
  }
  async rewind(plan, restoreFiles) {
    await this.mutate("Rewind session", async (scope) => {
      if (this.prepared?.scope !== scope || JSON.stringify(this.prepared.plan) !== JSON.stringify(plan)) throw new BridgeFailure("This rewind plan is stale or changed. Inspect the target again before confirming.");
      this.prepared = null;
      const response = result(await scope.client.executeRewind({ messageId: plan.messageId, filesToRestore: restoreFiles ? plan.filesToRestore : [], filesToDelete: restoreFiles ? plan.filesToDelete : [], forkTitle: this.state.session?.title ?? "Rewound conversation" }));
      await this.replace(scope, response.newSessionId);
      const failedRestore = typeof response.failedRestoreCount === "number" ? response.failedRestoreCount : 0;
      const failedDelete = typeof response.failedDeleteCount === "number" ? response.failedDeleteCount : 0;
      this.state.notice = failedRestore || failedDelete ? `Conversation rewound, but Droid reported ${failedRestore} failed restores and ${failedDelete} failed deletions. Inspect the files before continuing.` : "Droid rewound into a new session. The source session remains saved.";
    });
  }
  async close() {
    const scope = this.scope;
    this.scope = null;
    this.operation = null;
    this.cancelTurn(scope, "The bridge was closed. No prompt was replayed.");
    try {
      if (scope) await this.dispose(scope);
    } finally {
      if (!this.scope && !this.operation) {
        this.state.phase = "disconnected";
        this.state.workingState = null;
        this.state.approval = null;
        this.state.question = null;
        this.changed();
      }
    }
  }
  async connect(sessionId) {
    const connection = this.sdk.create(this.options);
    const scope = {
      client: connection.client,
      id: null,
      targetId: sessionId ?? null,
      loading: true,
      events: [],
      cleanups: [],
      locks: /* @__PURE__ */ new Map(),
      prompts: [],
      disposed: null,
      stopping: false,
      remoteBusy: false,
      connecting: null,
      revision: 0,
      permissionResults: /* @__PURE__ */ new Map(),
      questionResults: /* @__PURE__ */ new Map(),
      terminalIds: /* @__PURE__ */ new Set(),
      unansweredSnapshots: /* @__PURE__ */ new Set()
    };
    this.scope = scope;
    this.bind(scope);
    try {
      if (sessionId) {
        const lock = await SessionLock.acquire(this.options.dataDir, sessionId);
        if (this.scope !== scope) {
          await lock.release();
          throw new BridgeFailure("Session opening was cancelled.");
        }
        scope.locks.set(sessionId, lock);
      }
      if (this.scope !== scope) throw new BridgeFailure("Session opening was cancelled.");
      scope.connecting = connection.connect();
      await scope.connecting;
      if (this.scope !== scope) throw new BridgeFailure("Session opening was cancelled.");
      const response = sessionId ? result(await scope.client.loadSession({ sessionId, loadAllMessages: true })) : result(await scope.client.initializeSession({ machineId: "tern-bridge-droid", cwd: this.options.cwd }));
      if (this.scope !== scope) throw new BridgeFailure("Session opening was cancelled.");
      const id = sessionId ?? response.sessionId;
      if (typeof id !== "string") throw new BridgeFailure("Droid did not return a session ID.");
      if (!scope.locks.has(id)) {
        const lock = await SessionLock.acquire(this.options.dataDir, id);
        if (this.scope !== scope) {
          await lock.release();
          throw new BridgeFailure("Session opening was cancelled.");
        }
        scope.locks.set(id, lock);
      }
      if (this.scope !== scope) throw new BridgeFailure("Session opening was cancelled.");
      scope.id = id;
      scope.targetId = id;
      this.install(scope, response, !sessionId);
      try {
        const discovered = result(await scope.client.listModels());
        if (this.scope === scope) this.state.models = normalizeModels(discovered.models, this.state.session?.settings, this.state.models);
      } catch (error) {
        if (this.scope === scope) this.state.notice = failure(error, "Discover models").message;
      }
      await this.context(scope);
      this.changed();
    } catch (error) {
      if (this.scope === scope) this.scope = null;
      await this.dispose(scope);
      throw error;
    }
  }
  bind(scope) {
    const revision = ++scope.revision;
    for (const cleanup of scope.cleanups.splice(0)) cleanup();
    scope.cleanups.push(scope.client.onNotification((event) => {
      if (scope.revision === revision) this.notification(scope, event);
    }));
    scope.cleanups.push(scope.client.onError((error) => {
      if (this.scope !== scope || scope.revision !== revision) return;
      const problem = failure(error, "Droid connection");
      this.state.error = problem.message;
      this.state.phase = "error";
      this.state.workingState = null;
      this.transcript.finish("interrupted");
      this.cancelPrompts(scope);
      this.active?.settle(problem);
      this.changed();
    }));
    scope.client.setPermissionHandler((event) => scope.revision === revision ? this.permission(scope, event) : { selectedOption: ToolConfirmationOutcome.Cancel });
    scope.client.setAskUserHandler((event) => scope.revision === revision ? this.question(scope, event) : { cancelled: true, answers: [] });
  }
  install(scope, response, created = false) {
    if (this.scope !== scope || !scope.id) return;
    const session = record(response.session);
    this.transcript = new Transcript();
    this.transcript.hydrate(session.messages);
    this.state.messages = this.transcript.messages;
    this.state.session = {
      id: scope.id,
      title: typeof session.title === "string" ? session.title : "",
      cwd: typeof response.cwd === "string" ? response.cwd : typeof session.cwd === "string" ? session.cwd : created ? this.options.cwd : "",
      settings: settings(response.settings)
    };
    this.state.models = normalizeModels(response.availableModels, this.state.session.settings, this.state.models);
    this.state.context = null;
    this.state.usage = null;
    this.usage(response.tokenUsage);
    this.state.workingState = typeof response.workingState === "string" ? response.workingState : null;
    scope.remoteBusy = typeof response.workingState === "string" ? response.workingState !== "idle" : response.isAgentLoopInProgress === true;
    this.state.phase = scope.remoteBusy ? "running" : "idle";
    if (response.hasOlderMessages === true) this.state.notice = "Droid returned a partial transcript despite loadAllMessages. The CLI must provide full history before it can all be displayed.";
    scope.loading = false;
    const buffered = scope.events.splice(0);
    for (const event of buffered) this.notification(scope, event);
    const pendingSnapshots = [
      ...Array.isArray(response.pendingPermissions) ? response.pendingPermissions : [],
      ...Array.isArray(response.pendingAskUserRequests) ? response.pendingAskUserRequests : []
    ];
    scope.unansweredSnapshots.clear();
    for (const value of pendingSnapshots) {
      const id = record(value).requestId;
      if (typeof id === "string" && !scope.prompts.some((prompt) => prompt.id === id) && !scope.permissionResults.has(id) && !scope.questionResults.has(id)) scope.unansweredSnapshots.add(id);
    }
    if (scope.unansweredSnapshots.size) {
      this.state.notice = PENDING_SNAPSHOT_NOTICE;
      this.state.error = PENDING_SNAPSHOT_NOTICE;
      this.state.phase = "error";
    }
    this.showPrompt(scope);
  }
  notification(scope, value) {
    if (this.scope !== scope) return;
    const params = record(record(value).params);
    const event = record(params.notification);
    if (typeof event.type !== "string") return;
    const id = typeof params.sessionId === "string" ? params.sessionId : typeof event.sessionId === "string" ? event.sessionId : null;
    if (scope.loading) {
      if (!id || !scope.targetId || id === scope.targetId) scope.events.push(value);
      return;
    }
    if (id && id !== scope.id) {
      return;
    }
    this.transcript.apply(event);
    if (event.type === "create_message") {
      const message = record(event.message);
      const turn = this.active;
      if (turn?.scope === scope && !turn.accepted && typeof message.id === "string" && message.role === "user" && message.visibility !== "llm_only" && message.isUserVisible !== false && message.hiddenFromUserViews !== true && Array.isArray(message.content) && message.content.some((value2) => record(value2).type === "text" || record(value2).type === "image") && (message.id === turn.messageId || event.requestId === turn.requestId)) {
        turn.accepted = true;
        try {
          turn.accept();
        } catch {
          this.state.notice = "Droid accepted the message, but the editor could not acknowledge it.";
        }
      }
    } else if (event.type === "settings_updated" && this.state.session) {
      this.state.session.settings = settings(event.settings, this.state.session.settings);
      this.state.models = normalizeModels(this.state.models.map((model) => ({ id: model.id, displayName: model.label, supportedReasoningEfforts: model.reasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort, noImageSupport: model.noImageSupport })), this.state.session.settings);
    } else if (event.type === "session_title_updated" && this.state.session && typeof event.title === "string") this.state.session.title = event.title;
    else if (event.type === "session_working_directory_changed" && this.state.session && typeof event.cwd === "string") this.state.session.cwd = event.cwd;
    else if (event.type === "session_token_usage_changed") this.usage(event.tokenUsage);
    else if (event.type === "permission_resolved" && typeof event.requestId === "string") {
      const index = scope.prompts.findIndex((prompt2) => prompt2.id === event.requestId && prompt2.kind === "approval");
      const prompt = scope.prompts[index];
      if (index >= 0 && prompt?.kind === "approval") {
        scope.prompts.splice(index, 1);
        prompt.settle({ selectedOption: ToolConfirmationOutcome.Cancel });
      }
    } else if (event.type === "error") {
      this.state.error = failure({ name: event.errorType }, "Droid turn").message;
      this.state.notice = this.state.error;
    } else if (event.type === "droid_working_state_changed") {
      if (typeof event.newState === "string") this.state.workingState = event.newState;
      if (event.newState === "idle") {
        scope.remoteBusy = false;
        if (scope.stopping) this.complete(scope, "cancelled");
        else if (!this.active && !this.operation) this.state.phase = this.state.error ? "error" : "idle";
      } else if (typeof event.newState === "string") {
        scope.remoteBusy = true;
        if (scope.stopping) return;
        if (this.state.phase !== "stopping") this.state.phase = "running";
      }
    } else if (event.type === "agent_turn_completed") {
      const turn = this.active?.scope === scope && !this.active.completed ? this.active : null;
      if (typeof event.turnId !== "string") {
        if (turn) {
          const problem = new BridgeFailure("Droid ended a local turn without its required turn ID. Nothing was replayed. Stop or reopen the session before continuing.");
          this.state.error = problem.message;
          this.state.phase = "error";
          this.cancelPrompts(scope);
          turn.settle(problem);
          this.changed();
          return;
        }
        if (!scope.remoteBusy && !scope.stopping) return;
      } else {
        if (scope.terminalIds.has(event.turnId) || turn && event.turnId !== turn.messageId) return;
        if (!turn && !scope.remoteBusy && !scope.stopping) return;
        scope.terminalIds.add(event.turnId);
      }
      this.usage(event.cumulativeTokenUsage ?? event.tokenUsage);
      this.complete(scope, typeof event.reason === "string" ? event.reason : "error");
    }
    this.showPrompt(scope);
    this.changed();
  }
  complete(scope, reason) {
    if (this.scope !== scope) return;
    const interrupted = reason === "cancelled" || reason === "permission_rejected";
    const success = reason === "completed" || reason === "spec_handoff";
    this.transcript.finish(interrupted ? "interrupted" : success ? "done" : "error");
    this.cancelPrompts(scope);
    scope.stopping = false;
    scope.remoteBusy = false;
    this.state.workingState = null;
    if (this.active?.scope === scope) scope.terminalIds.add(this.active.messageId);
    scope.unansweredSnapshots.clear();
    if (this.state.error === PENDING_SNAPSHOT_NOTICE) this.state.error = null;
    this.state.phase = success || interrupted ? "idle" : "error";
    if (interrupted) this.state.notice = "Droid stopped. Partial messages have been preserved.";
    if (!success && !interrupted) {
      const reasons = {
        model_authentication_failed: "Model authentication failed. Check the existing Droid CLI login or provider configuration.",
        model_usage_exhausted: "The selected model has no remaining usage. Choose a model explicitly or check account limits.",
        model_provider_unreachable: "The model provider could not be reached. Nothing was resubmitted.",
        model_rate_limited: "The provider rate limited this turn. Nothing was resubmitted.",
        no_approver_available: "Droid could not reach an approver. Reopen the session before continuing.",
        completion_persistence_failed: "Droid could not persist the completed turn. Inspect the saved session before sending again."
      };
      this.state.error = reasons[reason] ?? this.state.error ?? "Droid ended the turn with an error. Partial messages are preserved; no prompt was replayed.";
    }
    if (success) this.state.error = null;
    if (this.active?.scope === scope) this.active.settle(this.state.phase === "error" ? new BridgeFailure(this.state.error ?? "Droid turn failed.") : void 0);
    void this.context(scope);
    this.changed();
  }
  permission(scope, value) {
    if (this.scope !== scope || scope.stopping || scope.disposed) return Promise.resolve({ selectedOption: ToolConfirmationOutcome.Cancel });
    const event = record(value);
    const params = record(event.params);
    const options = Array.isArray(params.options) ? params.options.map((value2) => record(value2)) : [];
    const uses = Array.isArray(params.toolUses) ? params.toolUses.map((value2) => record(value2)) : [];
    const details = [];
    const plans = [];
    const names = [];
    for (const use of uses) {
      const tool = record(use.toolUse);
      const detail = record(use.details);
      if (typeof tool.name === "string") names.push(tool.name);
      for (const key of ["title", "filePath", "fullCommand", "command", "impactLevel", "riskLevelReason", "reason", "target", "serverName", "toolName", "patchContent", "oldContent", "newContent", "content", "questionnaire", "proposal"]) {
        if (typeof detail[key] === "string") details.push(`${key}: ${detail[key]}`);
      }
      if (typeof detail.plan === "string") plans.push(detail.plan);
      if (Array.isArray(detail.files)) for (const file of detail.files) {
        const item = record(file);
        details.push(["operation", "filePath", "moveTo", "oldContent", "newContent"].filter((key) => typeof item[key] === "string").map((key) => `${key}: ${item[key]}`).join("\n"));
      }
    }
    const id = typeof event.id === "string" ? event.id : "";
    if (!id) return Promise.resolve({ selectedOption: ToolConfirmationOutcome.Cancel });
    scope.unansweredSnapshots.delete(id);
    const settled = scope.permissionResults.get(id);
    if (settled) return Promise.resolve(settled);
    const pending = scope.prompts.find((prompt) => prompt.kind === "approval" && prompt.id === id);
    if (pending?.kind === "approval") return pending.promise;
    const { promise, resolve: resolve3 } = Promise.withResolvers();
    scope.prompts.push({ kind: "approval", id, promise, settle(value2) {
      scope.permissionResults.set(id, value2);
      resolve3(value2);
    }, view: {
      id,
      title: names.join(", ") || "Droid permission",
      detail: details.join("\n\n"),
      ...plans.length ? { plan: plans.join("\n\n") } : {},
      options: options.flatMap((option) => typeof option.value === "string" && typeof option.label === "string" ? [{
        value: option.value,
        label: option.label,
        persistent: option.value.startsWith("proceed_always") || option.value.startsWith("proceed_auto_run"),
        ...option.value.startsWith("proceed_new_session") ? { disabledReason: "SDK 0.9.1 cannot authoritatively identify the new implementation session. Choose an offered current-session outcome, or cancel and use Fork explicitly." } : {}
      }] : [])
    } });
    this.showPrompt(scope);
    this.changed();
    return promise;
  }
  question(scope, value) {
    if (this.scope !== scope || scope.stopping || scope.disposed) return Promise.resolve({ cancelled: true, answers: [] });
    const event = record(value);
    const params = record(event.params);
    const id = typeof event.id === "string" ? event.id : "";
    if (!id) return Promise.resolve({ cancelled: true, answers: [] });
    scope.unansweredSnapshots.delete(id);
    const questions = Array.isArray(params.questions) ? params.questions.flatMap((value2) => {
      const item = record(value2);
      return typeof item.index === "number" && typeof item.question === "string" ? [{
        index: item.index,
        question: item.question,
        options: Array.isArray(item.options) ? item.options.filter((option) => typeof option === "string") : [],
        ...typeof item.topic === "string" ? { topic: item.topic } : {},
        ...typeof item.multiSelect === "boolean" ? { multiSelect: item.multiSelect } : {}
      }] : [];
    }) : [];
    const settled = scope.questionResults.get(id);
    if (settled) return Promise.resolve(settled);
    const pending = scope.prompts.find((prompt) => prompt.kind === "question" && prompt.id === id);
    if (pending?.kind === "question") return pending.promise;
    const { promise, resolve: resolve3 } = Promise.withResolvers();
    scope.prompts.push({ kind: "question", id, promise, settle(value2) {
      scope.questionResults.set(id, value2);
      resolve3(value2);
    }, view: { id, questions } });
    this.showPrompt(scope);
    this.changed();
    return promise;
  }
  showPrompt(scope) {
    if (this.scope !== scope) return;
    const prompt = scope.prompts[0];
    this.state.approval = prompt?.kind === "approval" ? prompt.view : null;
    this.state.question = prompt?.kind === "question" ? prompt.view : null;
    if (prompt && this.state.phase !== "stopping") this.state.phase = prompt.kind;
    else if (scope.unansweredSnapshots.size && this.state.phase !== "stopping") {
      this.state.phase = "error";
      this.state.error = PENDING_SNAPSHOT_NOTICE;
    } else if (this.state.phase === "approval" || this.state.phase === "question") this.state.phase = scope.remoteBusy || this.active && !this.active.completed ? "running" : "idle";
  }
  cancelPrompts(scope) {
    for (const prompt of scope.prompts.splice(0)) {
      if (prompt.kind === "approval") prompt.settle({ selectedOption: ToolConfirmationOutcome.Cancel });
      else prompt.settle({ cancelled: true, answers: [] });
    }
    if (this.scope === scope) {
      this.state.approval = null;
      this.state.question = null;
    }
  }
  async reload(scope) {
    if (!scope.id || this.scope !== scope) throw new BridgeFailure("The session changed before it could be loaded.");
    this.cancelPrompts(scope);
    scope.loading = true;
    scope.events.length = 0;
    scope.targetId = scope.id;
    try {
      const response = result(await scope.client.loadSession({ sessionId: scope.id, loadAllMessages: true }));
      if (this.scope !== scope) throw new BridgeFailure("The session changed while loading.");
      this.bind(scope);
      this.install(scope, response);
      await this.context(scope);
    } finally {
      scope.loading = false;
    }
  }
  async replace(scope, id) {
    if (typeof id !== "string" || !id) throw new BridgeFailure("Droid did not identify the replacement session. Open the session picker before continuing.");
    this.cancelPrompts(scope);
    this.prepared = null;
    const lock = await SessionLock.acquire(this.options.dataDir, id);
    if (this.scope !== scope) {
      await lock.release();
      throw new BridgeFailure("The session was closed during replacement.");
    }
    scope.locks.set(id, lock);
    const previous = scope.id;
    scope.permissionResults.clear();
    scope.questionResults.clear();
    scope.terminalIds.clear();
    scope.id = id;
    try {
      await this.reload(scope);
      if (previous && previous !== id) {
        await scope.locks.get(previous)?.release();
        scope.locks.delete(previous);
      }
    } catch (error) {
      this.state.notice = `Droid saved a successor session: ${id}. Open that ID to recover its history. The source was not replayed.`;
      throw error;
    }
  }
  async mutate(action, operation) {
    const scope = this.ready();
    if (scope.unansweredSnapshots.size) throw new BridgeFailure(PENDING_SNAPSHOT_NOTICE);
    if (this.operation || this.active || this.state.phase !== "idle") throw new BridgeFailure("Wait for Droid to become idle before changing the session.");
    const token = Symbol();
    this.operation = token;
    this.state.error = null;
    try {
      await operation(scope);
    } catch (error) {
      if (this.scope === scope) throw this.report(error, action);
      throw failure(error, action);
    } finally {
      if (this.operation === token) this.operation = null;
      this.changed();
    }
  }
  ready() {
    if (!this.scope?.id || !this.scope.client.isConnected || this.scope.loading) throw new BridgeFailure("Open a connected Droid session first.");
    return this.scope;
  }
  async context(scope) {
    const revision = scope.revision;
    try {
      const info = result(await scope.client.getContextStats());
      if (this.scope === scope && scope.revision === revision && typeof info.used === "number" && typeof info.limit === "number") this.state.context = { used: info.used, limit: info.limit };
    } catch {
    }
    if (this.scope === scope) this.changed();
  }
  usage(value) {
    const info = record(value);
    if (typeof info.inputTokens === "number" && typeof info.outputTokens === "number") this.state.usage = { input: info.inputTokens, output: info.outputTokens };
  }
  cancelTurn(scope, message) {
    if (!scope) return;
    this.cancelPrompts(scope);
    if (this.active?.scope === scope) this.active.settle(new BridgeFailure(message));
    this.transcript.finish("interrupted");
    this.prepared = null;
  }
  async dispose(scope) {
    if (scope.disposed) return scope.disposed;
    scope.disposed = (async () => {
      this.cancelPrompts(scope);
      for (const cleanup of scope.cleanups.splice(0)) cleanup();
      scope.client.clearPermissionHandler();
      scope.client.clearAskUserHandler();
      await scope.connecting?.catch(() => void 0);
      try {
        await scope.client.close();
      } finally {
        const releases = await Promise.allSettled([...scope.locks.values()].map((lock) => lock.release()));
        scope.locks.clear();
        if (releases.some((release) => release.status === "rejected")) throw new BridgeFailure("Droid closed, but a plugin session lock could not be removed. Check data-directory permissions before reopening that session.");
      }
    })();
    return scope.disposed;
  }
  report(error, action) {
    const problem = failure(error, action);
    this.state.error = problem.message;
    this.state.phase = "error";
    this.changed();
    return problem;
  }
  changed() {
    const scope = this.scope;
    this.state.needsInterrupt = !!scope?.client.isConnected && (scope.stopping || scope.remoteBusy || !!scope.unansweredSnapshots.size || this.active?.scope === scope && !this.active.completed);
    this.options.onChange();
  }
};

// src/omp-transcript.ts
import { Container } from "@oh-my-pi/pi-tui/tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { Markdown, fencedCode } from "@oh-my-pi/pi-tui/components/markdown";
import { Disclosure } from "@oh-my-pi/pi-tui/components/disclosure";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { nativeDiff, renderDiff } from "@oh-my-pi/pi-tui/chrome/diff";
import { describeCodeCell, renderCodeCell } from "@oh-my-pi/pi-tui/render/code-cell";
import { rootToggleExpanded } from "@oh-my-pi/pi-tui/native/node";
import { ansi, code, col, keyed } from "@oh-my-pi/pi-tui/native/describe";
import { numberedCode } from "@oh-my-pi/pi-tui/tools/grouped-file-output";
import { fileRow } from "@oh-my-pi/pi-tui/tools/native-view";
import { ensureThemeSync, getLanguageFromPath, getMarkdownTheme, getThemeEpoch, theme } from "@oh-my-pi/pi-tui/theme";

// src/tool-source.ts
function toolSourceParts(tool, args, languageForPath) {
  if (tool.status === "error" || !tool.output) return void 0;
  const input = record(args);
  if (tool.name === "Read") {
    const path = typeof input.file_path === "string" ? input.file_path : void 0;
    const lang = path ? languageForPath(path) : void 0;
    return lang ? [{ kind: "read", text: tool.output, lang }] : void 0;
  }
  if (tool.name !== "Grep" || input.output_mode !== "content") return void 0;
  const scope = typeof input.path === "string" ? input.path : void 0;
  const scopeLang = scope && input.line_numbers === true ? languageForPath(scope) : void 0;
  const location = /([:-])([1-9]\d*)\1/g;
  const parts = [];
  let hasSource = false;
  for (const line of tool.output.split("\n")) {
    let source;
    location.lastIndex = 0;
    for (let match = location.exec(line); match; match = location.exec(line)) {
      const path = line.slice(0, match.index);
      const lang = languageForPath(path);
      if (!lang) continue;
      const n = Number(match[2]);
      if (Number.isSafeInteger(n)) source = { path, lang, line: { n, text: line.slice(match.index + match[0].length), mark: match[1] === ":" } };
      break;
    }
    if (!source && scope && scopeLang) {
      const match = /^([1-9]\d*)([:-])(.*)$/.exec(line);
      const n = match ? Number(match[1]) : 0;
      if (match && Number.isSafeInteger(n)) source = { path: scope, lang: scopeLang, line: { n, text: match[3], mark: match[2] === ":" } };
    }
    const previous = parts.at(-1);
    if (source) {
      hasSource = true;
      if (previous?.kind === "matches" && previous.path === source.path && previous.lines.at(-1).n < source.line.n) {
        previous.lines.push(source.line);
      } else parts.push({ kind: "matches", path: source.path, lang: source.lang, lines: [source.line] });
    } else if (previous?.kind === "plain") previous.lines.push(line);
    else parts.push({ kind: "plain", lines: [line] });
  }
  return hasSource ? parts : void 0;
}

// src/omp-transcript.ts
var DroidToolCard = class extends ToolExecutionComponent {
  expanded = false;
  sourceArgs;
  sourceOutput;
  sourceError = false;
  sourceParts;
  sourceBody;
  projection;
  setSource(block, args) {
    const error = block.status === "error";
    if (this.sourceArgs === args && this.sourceOutput === block.output && this.sourceError === error) return;
    this.sourceArgs = args;
    this.sourceOutput = block.output;
    this.sourceError = error;
    this.sourceParts = toolSourceParts(block, args, getLanguageFromPath);
    this.sourceBody = void 0;
    this.projection = void 0;
  }
  describe(cx) {
    const original = super.describe(cx);
    if (!this.sourceParts || original.k !== "tool" || !original.c?.length || !cx?.supports("code")) return original;
    if (this.projection?.original === original) return this.projection.node;
    const body = this.sourceBody ??= this.sourceParts.flatMap((part, index) => {
      if (part.kind === "read") return [keyed(code(part.text, { lang: part.lang }), "source")];
      if (part.kind === "plain") return [keyed(ansi(part.lines.join("\n")), `notice-${index}`)];
      return [keyed(col([
        fileRow(part.path, { key: "file" }),
        ...numberedCode(part.lines, { lang: part.lang })
      ], { gap: "xs", role: "omp.tool.search.file" }), `source-${index}`)];
    });
    const node5 = { ...original, c: [...body, ...original.c.slice(1)] };
    this.projection = { original, node: node5 };
    return node5;
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    super.setExpanded(expanded);
  }
};
var SharedCodeCell = class {
  constructor(source, path) {
    this.source = source;
    this.path = path;
  }
  expanded = false;
  native;
  nativeEpoch = -1;
  rows;
  rowsEpoch = -1;
  width = 0;
  update(source, path) {
    this.source = source;
    this.path = path;
    this.invalidate();
  }
  setExpanded(expanded) {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.invalidate();
  }
  handleNativeEvent(event) {
    const expanded = rootToggleExpanded(event);
    if (expanded !== void 0) this.setExpanded(expanded);
  }
  describe() {
    const epoch = getThemeEpoch();
    if (!this.native || this.nativeEpoch !== epoch) {
      this.native = describeCodeCell({
        code: this.source,
        language: this.path ? getLanguageFromPath(this.path) : void 0,
        title: this.path,
        expanded: this.expanded
      }, theme);
      this.nativeEpoch = epoch;
    }
    return this.native;
  }
  render(width) {
    const epoch = getThemeEpoch();
    if (!this.rows || this.width !== width || this.rowsEpoch !== epoch) {
      this.rows = renderCodeCell({
        code: this.source,
        language: this.path ? getLanguageFromPath(this.path) : void 0,
        title: this.path,
        expanded: this.expanded,
        width
      }, theme);
      this.width = width;
      this.rowsEpoch = epoch;
    }
    return this.rows;
  }
  invalidate() {
    this.native = void 0;
    this.rows = void 0;
  }
};
var SharedDiff = class {
  constructor(source, path) {
    this.source = source;
    this.path = path;
    this.update(source, path);
  }
  fallback = new Markdown("", 0, 0, getMarkdownTheme());
  terminal = new Text("", 0, 0);
  compact = false;
  native;
  ansiEpoch = -1;
  update(source, path) {
    this.source = source;
    this.path = path;
    this.native = void 0;
    this.ansiEpoch = -1;
    this.compact = /[+\- ]\s*\d+\|/.test(source) && source.split("\n").every((line) => /^[+\- ]\s*\d+\|/.test(line) || /^\s*(?:…|\.\.\.)?\s*$/.test(line));
    if (!this.compact) this.fallback.setText(fencedCode("diff", source));
  }
  describe(cx) {
    if (!this.compact) return this.fallback.describe(cx);
    this.native ??= nativeDiff(this.source, { filePath: this.path });
    return this.native;
  }
  render(width) {
    if (!this.compact) return this.fallback.render(width);
    const epoch = getThemeEpoch();
    if (this.ansiEpoch !== epoch) {
      this.terminal.setText(renderDiff(this.source, { theme }));
      this.ansiEpoch = epoch;
    }
    return this.terminal.render(width);
  }
  invalidate() {
    this.native = void 0;
    this.ansiEpoch = -1;
    this.fallback.invalidate();
    this.terminal.invalidate();
  }
  releaseRenderCaches() {
    this.fallback.releaseRenderCaches();
    this.terminal.releaseRenderCaches();
  }
};
function sameBlock(previous, next) {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "tool" && next.kind === "tool") {
    return previous.name === next.name && previous.args === next.args && previous.output === next.output && previous.status === next.status && previous.diff === next.diff;
  }
  if (previous.kind === "image" && next.kind === "image") return previous.data === next.data && previous.mime === next.mime;
  return "text" in previous && "text" in next && previous.text === next.text && previous.path === next.path;
}
function toolArgs(source) {
  try {
    return JSON.parse(source);
  } catch {
    return source;
  }
}
var UNKNOWN_ASSISTANT_USAGE = Object.freeze({});
function isAssistantContent(block) {
  return block.kind === "text" || block.kind === "thinking" || block.kind === "image";
}
var DroidAssistantMessage = class extends AssistantMessageComponent {
  constructor(ui, persistenceKey, expanded) {
    super(void 0, false, () => ui.requestRender(), void 0, ui.imageBudget, false, void 0, expanded);
    this.persistenceKey = persistenceKey;
    this.setMidStreamPublication(false);
  }
  seen = 0;
  snapshots = [];
  content = [];
  view = { role: "assistant", content: this.content, usage: UNKNOWN_ASSISTANT_USAGE };
  live = false;
  messagePersistenceKey() {
    return this.persistenceKey;
  }
  sync(blocks, start, end, live, finalized) {
    const count = end - start;
    let changed = this.snapshots.length !== count;
    for (let index = 0; index < count; index++) {
      const block = blocks[start + index];
      const previous = this.snapshots[index];
      if (previous && sameBlock(previous, block)) continue;
      this.snapshots[index] = { ...block };
      this.content[index] = block.kind === "image" ? { type: "image", data: block.data, mimeType: block.mime } : block.kind === "thinking" ? { type: "thinking", thinking: block.text } : { type: "text", text: block.text };
      changed = true;
    }
    this.snapshots.length = count;
    this.content.length = count;
    if (!changed && this.live === live && (!finalized || this.isTranscriptBlockFinalized())) return false;
    this.live = live;
    this.updateContent(this.view, { transient: live });
    if (finalized && !this.isTranscriptBlockFinalized()) this.markTranscriptBlockFinalized();
    return true;
  }
  setExpanded(expanded) {
    super.setExpanded(expanded);
    this.setExpandThinkingBlocks(expanded);
  }
};
var DroidBlock = class extends Container {
  constructor(ui, cwd, role, imageKey, expanded) {
    super();
    this.ui = ui;
    this.cwd = cwd;
    this.role = role;
    this.imageKey = imageKey;
    this.expanded = expanded;
  }
  seen = 0;
  snapshot;
  markdown;
  thinking;
  code;
  tool;
  toolInput;
  diff;
  live = false;
  expanded = false;
  imageRevision = 0;
  currentImageKey;
  sync(block, live) {
    const previous = this.snapshot;
    const changed = !previous || !sameBlock(previous, block);
    if (!changed && this.live === live) return false;
    const reconstruct = !previous || previous.kind !== block.kind || previous.kind === "tool" && block.kind === "tool" && (previous.name !== block.name || previous.status === "interrupted" && block.status !== "interrupted");
    if (reconstruct) {
      this.expanded = this.tool?.expanded ?? this.thinking?.expanded ?? this.expanded;
      if (this.currentImageKey) {
        this.ui.imageBudget.release(this.currentImageKey);
        this.currentImageKey = void 0;
      }
      this.disposeChildren();
      this.markdown = void 0;
      this.thinking = void 0;
      this.code = void 0;
      this.tool = void 0;
      this.diff = void 0;
    }
    if (block.kind === "tool") this.syncTool(block, previous?.kind === "tool" ? previous : void 0);
    else if (block.kind === "image") {
      if (changed) {
        this.disposeChildren();
        if (this.currentImageKey) this.ui.imageBudget.release(this.currentImageKey);
        this.currentImageKey = `${this.imageKey}:${++this.imageRevision}`;
        this.addChild(new Image(block.data, block.mime, { fallbackColor: (text2) => theme.fg("dim", text2) }, {
          imageKey: this.currentImageKey,
          budget: this.ui.imageBudget,
          requestRender: () => this.ui.requestRender()
        }));
      }
    } else if (block.kind === "code") {
      if (!this.code) {
        this.code = new SharedCodeCell(block.text, block.path);
        this.code.setExpanded(this.expanded);
        this.addChild(this.code);
      } else if (changed) this.code.update(block.text, block.path);
    } else if (block.kind === "diff") {
      if (!this.diff) {
        this.diff = new SharedDiff(block.text, block.path);
        this.addChild(this.diff);
      } else if (changed) this.diff.update(block.text, block.path);
    } else if (block.kind === "thinking") {
      if (!this.markdown) {
        this.markdown = new Markdown(block.text, 1, 0, getMarkdownTheme());
        const body = this.markdown;
        this.thinking = new Disclosure({ summary: new Text("Thinking", 0, 0), body: () => body, expanded: this.expanded });
        this.addChild(this.thinking);
      } else if (changed) this.markdown.setText(block.text);
      this.markdown.transientRenderCache = live;
    } else if (this.role === "user") {
      if (changed) {
        this.disposeChildren();
        this.addChild(new UserMessageComponent(block.text));
      }
    } else {
      if (!this.markdown) {
        this.markdown = new Markdown(block.text, 1, 0, getMarkdownTheme());
        this.addChild(this.markdown);
      } else if (changed) this.markdown.setText(block.text);
      this.markdown.transientRenderCache = live;
    }
    if (changed) this.snapshot = { ...block };
    this.live = live;
    return true;
  }
  syncTool(block, previous) {
    if (!this.tool || block.args !== previous?.args) this.toolInput = toolArgs(block.args);
    if (!this.tool) {
      this.tool = new DroidToolCard(
        block.name,
        this.toolInput,
        { useBuiltInRenderer: false },
        void 0,
        this.ui,
        this.cwd,
        block.id
      );
      this.tool.setExpanded(this.expanded);
      this.addChild(this.tool);
    } else if (block.args !== previous?.args) this.tool.updateArgs(this.toolInput, block.id);
    this.tool.setSource(block, this.toolInput);
    if (!previous || previous.output !== block.output || previous.status !== block.status || !this.snapshot || previous.name !== block.name || previous.status === "interrupted" && block.status !== "interrupted") {
      this.tool.updateResult(
        { content: [{ type: "text", text: block.output }], isError: block.status === "error" },
        block.status === "running" || block.status === "interrupted",
        block.id
      );
      if (block.status === "interrupted") this.tool.seal();
    }
    if (block.diff !== void 0) {
      if (!this.diff) {
        this.diff = new SharedDiff(block.diff);
        this.addChild(this.diff);
      } else if (block.diff !== previous?.diff) this.diff.update(block.diff);
    } else if (this.diff) {
      this.removeChild(this.diff);
      this.diff = void 0;
    }
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    this.tool?.setExpanded(expanded);
    this.thinking?.setExpanded(expanded);
    this.code?.setExpanded(expanded);
  }
  dispose() {
    if (this.currentImageKey) {
      this.ui.imageBudget.release(this.currentImageKey);
      this.currentImageKey = void 0;
    }
    super.dispose();
  }
};
var DroidTranscript = class {
  constructor(ui, cwd) {
    this.ui = ui;
    this.cwd = cwd;
    ensureThemeSync();
  }
  container = new TranscriptContainer();
  messages = /* @__PURE__ */ new Map();
  sessionId;
  generation = 0;
  epoch = 0;
  expanded = false;
  disposed = false;
  sync(state) {
    if (this.disposed) return;
    const sessionId = state.session?.id ?? null;
    if (this.sessionId !== sessionId) {
      this.clear();
      this.sessionId = sessionId;
      this.generation++;
      this.ui.requestRender();
    }
    const epoch = ++this.epoch;
    let messageIndex = 0;
    let order;
    const last = state.messages.at(-1);
    for (const message of state.messages) {
      let entry = this.messages.get(message.id);
      if (entry && entry.role !== message.role) {
        entry.container.dispose();
        this.messages.delete(message.id);
        entry = void 0;
      }
      if (!entry) {
        entry = { role: message.role, container: new Container(), blocks: /* @__PURE__ */ new Map(), seen: epoch };
        this.messages.set(message.id, entry);
      }
      entry.seen = epoch;
      const live = state.needsInterrupt && message === last && message.streaming === true;
      let blockIndex = 0;
      let blockOrder;
      for (let sourceIndex = 0; sourceIndex < message.blocks.length; ) {
        const block = message.blocks[sourceIndex];
        const assistant = message.role === "assistant" && isAssistantContent(block);
        const key = assistant ? `assistant:${sourceIndex === 0 ? "" : message.blocks[sourceIndex - 1].id}` : `block:${block.id}`;
        let component = entry.blocks.get(key);
        let changed;
        if (assistant) {
          const start = sourceIndex++;
          while (sourceIndex < message.blocks.length && isAssistantContent(message.blocks[sourceIndex])) sourceIndex++;
          if (!(component instanceof DroidAssistantMessage)) {
            component?.dispose();
            component = new DroidAssistantMessage(this.ui, JSON.stringify([sessionId, message.id, key]), this.expanded);
            entry.blocks.set(key, component);
          }
          changed = component.sync(
            message.blocks,
            start,
            sourceIndex,
            live && sourceIndex === message.blocks.length,
            message.streaming === void 0 || sourceIndex < message.blocks.length
          );
        } else {
          sourceIndex++;
          if (!(component instanceof DroidBlock)) {
            component?.dispose();
            component = new DroidBlock(
              this.ui,
              state.session?.cwd || this.cwd,
              message.role,
              JSON.stringify([this.generation, sessionId, message.id, block.id]),
              this.expanded
            );
            entry.blocks.set(key, component);
          }
          changed = component.sync(block, live);
        }
        component.seen = epoch;
        if (changed) this.ui.requestComponentRender(component);
        if (!blockOrder && entry.container.children[blockIndex] !== component) blockOrder = entry.container.children.slice(0, blockIndex);
        blockOrder?.push(component);
        blockIndex++;
      }
      for (const [id, component] of entry.blocks) {
        if (component.seen !== epoch) {
          component.dispose();
          entry.blocks.delete(id);
        }
      }
      if (blockOrder || entry.container.children.length !== blockIndex) {
        entry.container.children = blockOrder ?? entry.container.children.slice(0, blockIndex);
        this.ui.requestComponentRender(entry.container);
      }
      if (!order && this.container.children[messageIndex] !== entry.container) order = this.container.children.slice(0, messageIndex);
      order?.push(entry.container);
      messageIndex++;
    }
    for (const [id, entry] of this.messages) {
      if (entry.seen !== epoch) {
        entry.container.dispose();
        this.messages.delete(id);
      }
    }
    if (order || this.container.children.length !== messageIndex) {
      this.container.children = order ?? this.container.children.slice(0, messageIndex);
      this.ui.requestRender();
    }
  }
  setExpanded(expanded) {
    if (this.disposed) return;
    this.expanded = expanded;
    for (const entry of this.messages.values()) for (const component of entry.blocks.values()) component.setExpanded(expanded);
    this.ui.requestRender();
  }
  clear() {
    for (const entry of this.messages.values()) entry.container.dispose();
    this.messages.clear();
    this.container.clear();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }
};

// src/omp-dialogs.ts
import { ApprovalDialogComponent } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";

// src/i18n.ts
var en = {
  identity: "Droid",
  untitled: "Untitled session",
  newSession: "New",
  sessions: "Sessions",
  model: "Model",
  reasoning: "Reasoning",
  mode: "Mode",
  autonomy: "Autonomy",
  default: "Default",
  autonomyOff: "Off",
  autonomyLow: "Low",
  autonomyMedium: "Medium",
  autonomyHigh: "High",
  send: "Send",
  stop: "Stop",
  draft: "Message Droid",
  draftHint: "Enter to send \xB7 Shift+Enter for a new line",
  imagePathInvalid: "Cannot read this local image. Check the file path and permissions.",
  imageInvalid: "Paste a valid JPEG, PNG, GIF or WebP image.",
  imageTooLarge: "This image exceeds the 20 MiB attachment limit.",
  imageClipboardFailed: "Cannot read the clipboard. Copy the image again, then paste it into the message.",
  imageUnsupportedModel: "This Droid model does not support images. Choose an image-capable model or remove the images.",
  imageEmptyDraft: "Enter a message or paste an image before sending.",
  empty: "Start a conversation in this project.",
  context: "Context",
  contextLoading: "Loading context usage\u2026",
  contextFailed: "Context usage is unavailable. Check the Droid CLI version and connection, then retry.",
  contextUnavailable: "Droid has not reported a context budget for this session.",
  contextFree: "Free space",
  contextThresholdUnknown: "Droid does not report its auto-compaction threshold through this API.",
  contextSystemPrompt: "System prompt",
  contextSystemTools: "System tools",
  contextMcpTools: "MCP tools",
  contextUserInfo: "User context",
  contextAgentsMd: "AGENTS.md",
  contextDroids: "Droids",
  contextSkills: "Skills",
  contextMessages: "Messages",
  retry: "Retry",
  tasks: "Tasks",
  working: "Working\u2026",
  workingThinking: "Thinking\u2026",
  workingCompaction: "Compacting context\u2026",
  thinking: "Thinking",
  user: "You",
  assistant: "Droid",
  system: "Session",
  args: "Arguments",
  toolOutput: "Output",
  done: "Done",
  interrupted: "Interrupted",
  failed: "Error",
  close: "Close",
  cancel: "Cancel",
  continue: "Continue",
  searchSessions: "Search sessions",
  searchModels: "Search models",
  noResults: "No matches",
  loading: "Loading sessions\u2026",
  currentProject: "This project",
  allProjects: "All projects",
  current: "Current",
  rename: "Rename session",
  compact: "Compact context",
  resume: "Resume by session ID",
  renameHint: "Session title",
  compactHint: "Optional instructions for compaction",
  resumeHint: "Session ID",
  editPlanHint: "Edit the plan before accepting",
  rewind: "Rewind conversation",
  rewindHint: "Choose the user message to return to. Later messages will be removed.",
  rewindConfirm: "Confirm rewind",
  rewindDetail: "Remove messages after this point. File restoration is a separate, explicit choice.",
  restore: "Restore",
  remove: "Delete",
  unavailable: "Cannot restore",
  noFiles: "No file changes are included.",
  conversationOnly: "Conversation only",
  restoreFiles: "Rewind and restore files",
  unavailableHint: "Some file snapshots are unavailable. File restoration is disabled; you can still rewind the conversation.",
  permission: "Permission request",
  plan: "Plan acceptance",
  planHint: "Choosing an offered acceptance option authorizes this plan. It is not only a permission grant.",
  persistent: "Persistent grant",
  once: "This request only",
  persistentHint: "Persistent options apply to future matching requests. Choose one only if you intend to keep granting access.",
  noPermissions: "Droid has not offered permission options. Cancel to decline.",
  answer: "Answer",
  customAnswer: "Write your own answer",
  submitAnswer: "Submit answer",
  cancelQuestion: "Cancel question",
  questionProgress: "Question",
  answered: "Answered",
  reconnect: "Reconnect session",
  reconnectHint: "Reconnect only; your message will not be sent again.",
  dismiss: "Dismiss error",
  image: "Conversation image",
  unknown: "Not reported",
  language: "Language"
};
var zh = {
  editPlanHint: "\u4FEE\u6539\u8BA1\u5212\u540E\u63A5\u53D7",
  identity: "Droid",
  untitled: "\u672A\u547D\u540D\u4F1A\u8BDD",
  newSession: "\u65B0\u5EFA",
  sessions: "\u4F1A\u8BDD",
  model: "\u6A21\u578B",
  reasoning: "\u601D\u8003\u5F3A\u5EA6",
  mode: "\u6A21\u5F0F",
  autonomy: "\u81EA\u4E3B\u6743\u9650",
  default: "\u9ED8\u8BA4",
  autonomyOff: "\u5173\u95ED",
  autonomyLow: "\u4F4E",
  autonomyMedium: "\u4E2D",
  autonomyHigh: "\u9AD8",
  send: "\u53D1\u9001",
  stop: "\u505C\u6B62",
  draft: "\u7ED9 Droid \u53D1\u6D88\u606F",
  draftHint: "Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C",
  imagePathInvalid: "\u65E0\u6CD5\u8BFB\u53D6\u672C\u5730\u56FE\u7247\uFF0C\u8BF7\u68C0\u67E5\u6587\u4EF6\u8DEF\u5F84\u548C\u8BFB\u53D6\u6743\u9650\u3002",
  imageInvalid: "\u8BF7\u7C98\u8D34\u6709\u6548\u7684 JPEG\u3001PNG\u3001GIF \u6216 WebP \u56FE\u7247\u3002",
  imageTooLarge: "\u56FE\u7247\u8D85\u8FC7 20 MiB \u9644\u4EF6\u4E0A\u9650\u3002",
  imageClipboardFailed: "\u65E0\u6CD5\u8BFB\u53D6\u526A\u8D34\u677F\uFF0C\u8BF7\u91CD\u65B0\u590D\u5236\u56FE\u7247\u540E\u7C98\u8D34\u5230\u8F93\u5165\u6846\u3002",
  imageUnsupportedModel: "\u5F53\u524D Droid \u6A21\u578B\u4E0D\u652F\u6301\u56FE\u7247\uFF0C\u8BF7\u9009\u62E9\u652F\u6301\u56FE\u7247\u7684\u6A21\u578B\uFF0C\u6216\u79FB\u9664\u56FE\u7247\u540E\u53D1\u9001\u3002",
  imageEmptyDraft: "\u8BF7\u8F93\u5165\u6D88\u606F\u6216\u7C98\u8D34\u56FE\u7247\u540E\u518D\u53D1\u9001\u3002",
  empty: "\u5728\u5F53\u524D\u9879\u76EE\u5F00\u59CB\u5BF9\u8BDD\u3002",
  context: "\u4E0A\u4E0B\u6587",
  contextLoading: "\u6B63\u5728\u8BFB\u53D6\u4E0A\u4E0B\u6587\u7528\u91CF\u2026",
  contextFailed: "\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\u4E0A\u4E0B\u6587\u7528\u91CF\u3002\u8BF7\u68C0\u67E5 Droid CLI \u7248\u672C\u548C\u8FDE\u63A5\u540E\u91CD\u8BD5\u3002",
  contextUnavailable: "Droid \u5C1A\u672A\u63D0\u4F9B\u6B64\u4F1A\u8BDD\u7684\u4E0A\u4E0B\u6587\u5BB9\u91CF\u3002",
  contextFree: "\u5269\u4F59\u7A7A\u95F4",
  contextThresholdUnknown: "Droid \u672A\u901A\u8FC7\u6B64\u63A5\u53E3\u63D0\u4F9B\u81EA\u52A8\u538B\u7F29\u9608\u503C\u3002",
  contextSystemPrompt: "\u7CFB\u7EDF\u63D0\u793A\u8BCD",
  contextSystemTools: "\u7CFB\u7EDF\u5DE5\u5177",
  contextMcpTools: "MCP \u5DE5\u5177",
  contextUserInfo: "\u7528\u6237\u4E0A\u4E0B\u6587",
  contextAgentsMd: "AGENTS.md",
  contextDroids: "Droid \u914D\u7F6E",
  contextSkills: "\u6280\u80FD",
  contextMessages: "\u4F1A\u8BDD\u6D88\u606F",
  retry: "\u91CD\u8BD5",
  tasks: "\u4EFB\u52A1",
  working: "\u6B63\u5728\u5904\u7406\u2026",
  workingThinking: "\u601D\u8003\u4E2D\u2026",
  workingCompaction: "\u6B63\u5728\u538B\u7F29\u4E0A\u4E0B\u6587\u2026",
  thinking: "\u601D\u8003\u8FC7\u7A0B",
  user: "\u4F60",
  assistant: "Droid",
  system: "\u4F1A\u8BDD",
  args: "\u53C2\u6570",
  toolOutput: "\u8F93\u51FA",
  done: "\u5B8C\u6210",
  interrupted: "\u5DF2\u4E2D\u65AD",
  failed: "\u9519\u8BEF",
  close: "\u5173\u95ED",
  cancel: "\u53D6\u6D88",
  continue: "\u7EE7\u7EED",
  searchSessions: "\u641C\u7D22\u4F1A\u8BDD",
  searchModels: "\u641C\u7D22\u6A21\u578B",
  noResults: "\u6CA1\u6709\u5339\u914D\u9879",
  loading: "\u6B63\u5728\u52A0\u8F7D\u4F1A\u8BDD\u2026",
  currentProject: "\u5F53\u524D\u9879\u76EE",
  allProjects: "\u6240\u6709\u9879\u76EE",
  current: "\u5F53\u524D",
  rename: "\u91CD\u547D\u540D\u4F1A\u8BDD",
  compact: "\u538B\u7F29\u4E0A\u4E0B\u6587",
  resume: "\u6309\u4F1A\u8BDD ID \u6062\u590D",
  renameHint: "\u4F1A\u8BDD\u540D\u79F0",
  compactHint: "\u53EF\u9009\uFF1A\u538B\u7F29\u65F6\u4FDD\u7559\u54EA\u4E9B\u4FE1\u606F",
  resumeHint: "\u4F1A\u8BDD ID",
  rewind: "\u56DE\u9000\u5BF9\u8BDD",
  rewindHint: "\u9009\u62E9\u8981\u56DE\u5230\u7684\u7528\u6237\u6D88\u606F\uFF0C\u4E4B\u540E\u7684\u6D88\u606F\u5C06\u88AB\u79FB\u9664\u3002",
  rewindConfirm: "\u786E\u8BA4\u56DE\u9000",
  rewindDetail: "\u79FB\u9664\u6B64\u5904\u4E4B\u540E\u7684\u6D88\u606F\u3002\u662F\u5426\u6062\u590D\u6587\u4EF6\uFF0C\u9700\u8981\u53E6\u884C\u660E\u786E\u9009\u62E9\u3002",
  restore: "\u6062\u590D",
  remove: "\u5220\u9664",
  unavailable: "\u65E0\u6CD5\u6062\u590D",
  noFiles: "\u6B64\u6B21\u56DE\u9000\u4E0D\u6D89\u53CA\u6587\u4EF6\u53D8\u66F4\u3002",
  conversationOnly: "\u4EC5\u56DE\u9000\u5BF9\u8BDD",
  restoreFiles: "\u56DE\u9000\u5E76\u6062\u590D\u6587\u4EF6",
  unavailableHint: "\u90E8\u5206\u6587\u4EF6\u5FEB\u7167\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u6062\u590D\u6587\u4EF6\uFF1B\u4ECD\u53EF\u4EC5\u56DE\u9000\u5BF9\u8BDD\u3002",
  permission: "\u6743\u9650\u8BF7\u6C42",
  plan: "\u63A5\u53D7\u8BA1\u5212",
  planHint: "\u9009\u62E9 Droid \u63D0\u4F9B\u7684\u63A5\u53D7\u9009\u9879\u4F1A\u6388\u6743\u6267\u884C\u6B64\u8BA1\u5212\uFF0C\u4E0D\u53EA\u662F\u6388\u4E88\u6743\u9650\u3002",
  persistent: "\u6301\u7EED\u6388\u6743",
  once: "\u4EC5\u672C\u6B21\u8BF7\u6C42",
  persistentHint: "\u6301\u7EED\u6388\u6743\u4F1A\u7528\u4E8E\u4E4B\u540E\u5339\u914D\u7684\u8BF7\u6C42\uFF0C\u8BF7\u786E\u8BA4\u8FD9\u662F\u4F60\u7684\u610F\u56FE\u3002",
  noPermissions: "Droid \u672A\u63D0\u4F9B\u6388\u6743\u9009\u9879\uFF0C\u53EF\u53D6\u6D88\u4EE5\u62D2\u7EDD\u3002",
  answer: "\u56DE\u7B54",
  customAnswer: "\u586B\u5199\u5176\u4ED6\u56DE\u7B54",
  submitAnswer: "\u63D0\u4EA4\u56DE\u7B54",
  cancelQuestion: "\u53D6\u6D88\u63D0\u95EE",
  questionProgress: "\u95EE\u9898",
  answered: "\u5DF2\u56DE\u7B54",
  reconnect: "\u91CD\u65B0\u8FDE\u63A5\u4F1A\u8BDD",
  reconnectHint: "\u53EA\u91CD\u65B0\u8FDE\u63A5\uFF0C\u4E0D\u4F1A\u518D\u6B21\u53D1\u9001\u4F60\u7684\u6D88\u606F\u3002",
  dismiss: "\u6536\u8D77\u9519\u8BEF",
  image: "\u5BF9\u8BDD\u56FE\u7247",
  unknown: "\u672A\u63D0\u4F9B",
  language: "\u8BED\u8A00"
};
function dictionary(locale) {
  return locale === "zh-CN" ? zh : en;
}

// src/omp-dialogs.ts
import { Text as Text3 } from "@oh-my-pi/pi-tui/components/text";

// src/omp-context.ts
import { Text as Text2 } from "@oh-my-pi/pi-tui/components/text";
import { ContextUsageView } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import { actionBar, actionButton } from "@oh-my-pi/pi-tui/native/overlay";
import { col as col2, node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import { theme as theme2 } from "@oh-my-pi/pi-tui/theme";
var DroidContextView = class extends ContextUsageView {
  constructor(details, locale) {
    const t = dictionary(locale);
    const categories = {
      systemPrompt: [t.contextSystemPrompt, "accent"],
      systemTools: [t.contextSystemTools, "warning"],
      mcpTools: [t.contextMcpTools, "warning"],
      userInfo: [t.contextUserInfo, "customMessageLabel"],
      agentsMd: [t.contextAgentsMd, "customMessageLabel"],
      customAgents: [t.contextDroids, "customMessageLabel"],
      skills: [t.contextSkills, "success"],
      messages: [t.contextMessages, "userMessageText"]
    };
    super({
      model: void 0,
      contextWindow: details.contextBudget,
      usedTokens: details.usedTokens,
      freeTokens: details.freeTokens,
      autoCompactBufferTokens: 0,
      categories: details.categories.map((category, index) => ({
        // In the pinned omp view this closed type is only an opaque sibling key.
        // Droid has eight categories, not omp's five; retain each one separately.
        id: `droid-${index}`,
        label: locale === "zh-CN" ? categories[category.colorKey][0] : category.name,
        tokens: category.tokens,
        color: categories[category.colorKey][1],
        glyph: "\u25A0"
      }))
    }, theme2);
    this.details = details;
    this.locale = locale;
  }
  projected;
  describe(cx) {
    const t = dictionary(this.locale);
    if (!(this.details.contextBudget > 0)) return text(t.contextUnavailable);
    const original = super.describe(cx);
    if (this.projected?.original === original) return this.projected.node;
    const count = (value) => value.toLocaleString(this.locale);
    const percent = new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 });
    const project = (source) => {
      const children = source.c?.map((child) => "k" in child ? project(child) : child);
      if (source.k === "text" && source.p?.role === "omp.context.used") return {
        ...source,
        p: { ...source.p, spans: [
          span(count(this.details.usedTokens), "strong"),
          span(` / ${count(this.details.contextBudget)} tokens \xB7 ${percent.format(this.details.usedTokens / this.details.contextBudget)}`, "dim")
        ] }
      };
      if (source.k === "text" && source.p?.role === "omp.context.room") return {
        ...source,
        p: { ...source.p, text: `${t.contextFree}: ${count(this.details.freeTokens)}` }
      };
      if (source.k === "row" && source.p?.role === "omp.context.cat.free") return {
        ...source,
        p: { ...source.p, title: `${t.contextFree} \xB7 ${count(this.details.freeTokens)} tokens` },
        c: children?.map((child) => "k" in child && child.k === "text" && child.p?.role === "omp.context.label" ? { ...child, p: { ...child.p, text: t.contextFree } } : child)
      };
      if (source.k === "meter" && source.p) return {
        ...source,
        p: {
          ...source.p,
          aria: t.context,
          parts: source.p?.parts?.map((part) => part.token === "track" ? { ...part, label: `${t.contextFree} \xB7 ${count(this.details.freeTokens)} tokens` } : part)
        }
      };
      return { ...source, ...children ? { c: children } : {} };
    };
    const projected = col2([project(original), text(t.contextThresholdUnknown, { role: "omp.context.snap.note" })], { gap: "md" });
    this.projected = { original, node: projected };
    return projected;
  }
};
var DroidContextLoading = class extends Text2 {
  native;
  constructor(locale) {
    const label = dictionary(locale).contextLoading;
    super(label, 0, 0);
    this.native = node("row", { gap: "sm", align: "center" }, [node("spinner", {}), text(label)]);
  }
  describe() {
    return this.native;
  }
};
var DroidContextReport = class extends ReportPanel {
  constructor(title, body, locale, close, retry) {
    super({ title, body, closeKey: "Esc", onClose: close });
    this.locale = locale;
    this.retry = retry;
    this.holdFocus();
  }
  projected;
  describe() {
    const original = super.describe();
    if (this.projected?.original === original) return this.projected.node;
    const t = dictionary(this.locale);
    const projected = { ...original, c: [
      original.c[0],
      actionBar([
        ...this.retry ? [actionButton(t.retry, "context.retry")] : [],
        null,
        actionButton(t.close, "close", { keys: "escape" })
      ])
    ] };
    this.projected = { original, node: projected };
    return projected;
  }
  handleNativeEvent(event) {
    if (event.type === "action" && event.act === "context.retry") this.retry?.();
    else super.handleNativeEvent(event);
  }
};

// src/omp-dialogs.ts
var DroidModalSelector = class extends HookSelectorComponent {
  nativeSheet(cx) {
    return cx.supports("picker");
  }
};
var DroidSessionSelector = class extends SessionSelectorComponent {
  missingDates = /* @__PURE__ */ new Set();
  loadingMessage;
  descriptions = /* @__PURE__ */ new WeakMap();
  describe(cx) {
    const original = super.describe(cx);
    if (original.k !== "picker" || !original.p) return original;
    const cached = this.descriptions.get(original);
    if (cached) return cached;
    const props = original.p;
    const projectItems = (items) => items.map((item) => {
      const facts = { ...item.facts };
      delete facts.size;
      const projected2 = { ...item, facts };
      if (this.missingDates.has(item.id)) {
        delete facts.when;
        delete projected2.title;
      }
      return projected2;
    });
    const children = original.c?.map((child) => {
      if (!("k" in child) || child.k !== "kv" || !child.p) return child;
      return { ...child, p: { ...child.p, items: child.p.items.filter((fact) => {
        const label = typeof fact.k === "string" ? fact.k : fact.k.map((part) => part.t).join("");
        if (label === "Size") return false;
        return label !== "Modified" || !this.missingDates.has(props.selected ?? "");
      }) } };
    });
    const projected = {
      ...original,
      p: {
        ...props,
        columns: props.columns?.filter((column) => column.id !== "size"),
        ...props.items ? { items: projectItems(props.items) } : {},
        ...props.itemsAdd ? { itemsAdd: projectItems(props.itemsAdd) } : {},
        // An absent date must not silently claim the upstream "Earlier" day group.
        ...props.order?.some((item) => typeof item === "string" && this.missingDates.has(item)) ? { order: props.order.filter((item) => typeof item === "string") } : {},
        ...this.loadingMessage ? { state: "loading", message: this.loadingMessage } : {}
      },
      c: children
    };
    this.descriptions.set(original, projected);
    return projected;
  }
};
var DroidDialogs = class {
  constructor(composer, backend, options) {
    this.composer = composer;
    this.backend = backend;
    this.options = options;
  }
  modal;
  prompt;
  disposed = false;
  async sessions() {
    this.syncPrompts();
    await this.showModal((controls) => {
      const text2 = dictionary(this.options.locale());
      let generation = 0;
      let opening = false;
      const missingDates = /* @__PURE__ */ new Set();
      const close = () => controls.finish(void 0);
      const entries = (items) => items.map((item) => {
        const parsed = new Date(item.modifiedTime ?? Number.NaN);
        const missingDate = Number.isNaN(parsed.getTime());
        if (missingDate) missingDates.add(item.id);
        else missingDates.delete(item.id);
        return {
          // This is an opaque Droid identity, never a session file to read or delete.
          path: item.id,
          id: item.id,
          cwd: item.cwd ?? "",
          title: item.title,
          // Private API placeholders only: describe() removes every corresponding
          // fact, preview and date group before Tern sees the original picker.
          modified: missingDate ? /* @__PURE__ */ new Date(0) : parsed,
          size: 0,
          firstMessage: "",
          allMessagesText: ""
        };
      });
      const picker = (items, loading = false) => {
        const component = new DroidSessionSelector(items, (session) => {
          if (!controls.active() || opening || loading) return;
          opening = true;
          component.lockInput();
          void this.options.openSession(session.id).then(() => {
            if (controls.active()) close();
          }).catch((error) => {
            if (!controls.active()) return;
            opening = false;
            component.unlockInput();
            this.options.onError(error);
            this.options.onChange();
          });
        }, close, close, {
          title: loading ? text2.loading : text2.sessions,
          showCwd: false,
          currentSessionPath: () => this.backend.state.session?.id,
          getTerminalRows: () => this.composer.ui.terminal.rows,
          ...loading ? {} : {
            loadAllSessions: async () => {
              try {
                const all = await this.backend.sessions(true);
                if (!controls.active()) throw new Error("Session selector was closed.");
                return entries(all);
              } catch (error) {
                if (controls.active()) this.options.onError(error);
                throw error;
              }
            }
          }
        });
        component.missingDates = missingDates;
        component.loadingMessage = loading ? text2.loading : void 0;
        component.getSessionList().onDeleteRequest = void 0;
        component.setOnRequestRender(() => {
          if (controls.active()) this.options.onChange();
        });
        return component;
      };
      const load = async () => {
        const current = ++generation;
        try {
          const items = await this.backend.sessions(false);
          if (controls.active() && current === generation) controls.replace(picker(entries(items)));
        } catch (error) {
          if (!controls.active() || current !== generation) return;
          this.options.onError(error);
          const retry = this.options.locale() === "zh-CN" ? "\u91CD\u8BD5" : "Retry";
          controls.replace(new DroidModalSelector(
            `${text2.sessions}
${error instanceof Error ? error.message : String(error)}`,
            [retry, text2.cancel],
            (selected) => {
              if (!controls.active()) return;
              if (selected !== retry) {
                close();
                return;
              }
              controls.replace(picker([], true));
              void load();
            },
            close,
            { tui: this.composer.ui }
          ));
        }
      };
      queueMicrotask(() => {
        if (controls.active()) void load();
      });
      return picker([], true);
    });
  }
  async context() {
    this.syncPrompts();
    const sessionId = this.backend.state.session?.id ?? null;
    await this.showModal((controls) => {
      const locale = this.options.locale();
      const t = dictionary(locale);
      const close = () => controls.finish(void 0);
      const loading = () => new DroidContextReport(t.context, new DroidContextLoading(locale), locale, close);
      let pending = false;
      const load = async () => {
        if (!controls.active() || pending) return;
        pending = true;
        try {
          const details = await this.backend.contextDetails();
          if (controls.active()) controls.replace(new DroidContextReport(
            `${t.context} \xB7 ${details.modelDisplayName || details.modelId}`,
            new DroidContextView(details, locale),
            locale,
            close
          ));
        } catch {
          if (controls.active()) controls.replace(new DroidContextReport(
            t.context,
            new Text3(t.contextFailed, 0, 0),
            locale,
            close,
            () => {
              if (!controls.active() || pending) return;
              controls.replace(loading());
              void load();
            }
          ));
        } finally {
          pending = false;
        }
      };
      queueMicrotask(() => {
        if (controls.active()) void load();
      });
      return loading();
    }, void 0, sessionId);
  }
  async choose(title, choices) {
    this.syncPrompts();
    const offered = choices.map((choice) => ({ ...choice }));
    return this.showModal((controls) => {
      const rows = this.choiceRows(offered);
      return new DroidModalSelector(title, rows, (label) => {
        if (!controls.active()) return;
        const index = rows.findIndex((row) => row.label === label);
        const choice = offered[index];
        if (choice && !choice.disabledReason) controls.finish(choice.value);
      }, () => controls.finish(void 0), {
        tui: this.composer.ui,
        disabledIndices: offered.flatMap((choice, index) => choice.disabledReason ? [index] : [])
      });
    });
  }
  input(title, initial, detail) {
    this.syncPrompts();
    return this.edit(title, initial, detail);
  }
  async confirm(title, detail) {
    this.syncPrompts();
    return await this.showModal((controls) => new ApprovalDialogComponent(
      `${title}
${detail}`,
      {
        onApprove: () => {
          if (controls.active()) controls.finish(true);
        },
        onDeny: () => controls.finish(false)
      },
      { tui: this.composer.ui, fullPrompt: `${title}
${detail}` }
    )) === true;
  }
  syncPrompts() {
    if (this.disposed) return void 0;
    const live = this.livePrompt();
    const sessionId = this.backend.state.session?.id;
    if (this.modal?.sessionId !== void 0 && this.modal.sessionId !== (sessionId ?? null)) this.modal.cancel();
    const signature = live ? JSON.stringify(live.source) : "";
    if (this.prompt && (!live || this.prompt.kind !== live.kind || this.prompt.source !== live.source || this.prompt.sessionId !== sessionId || this.prompt.signature !== signature)) {
      const old = this.prompt;
      this.prompt = void 0;
      old.settled = true;
      if (this.modal?.owner === old) this.modal.cancel();
      old.component?.dispose?.();
    }
    if (!live) return void 0;
    if (this.modal && !this.modal.owner) this.modal.cancel();
    if (!this.prompt) {
      const prompt = {
        ...live,
        sessionId,
        signature,
        settled: false,
        processing: false
      };
      this.prompt = prompt;
      if (prompt.kind === "approval") this.approvalChoices(prompt);
      else this.questions(prompt);
    }
    return this.prompt.component;
  }
  hasOverlay() {
    return !!this.modal && !this.modal.handle.isHidden() && this.modalCurrent(this.modal);
  }
  cancelOverlay() {
    this.syncPrompts();
    if (!this.hasOverlay()) return false;
    this.modal.cancel();
    return true;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const prompt = this.prompt;
    this.prompt = void 0;
    if (prompt) prompt.settled = true;
    this.modal?.cancel();
    prompt?.component?.dispose?.();
  }
  livePrompt() {
    const state = this.backend.state;
    if (state.phase === "approval" && state.approval) return { kind: "approval", source: state.approval };
    if (state.phase === "question" && state.question) return { kind: "question", source: state.question };
    return void 0;
  }
  current(prompt) {
    const live = this.livePrompt();
    return !this.disposed && this.prompt === prompt && !prompt.settled && this.backend.state.session?.id === prompt.sessionId && live?.kind === prompt.kind && live.source === prompt.source && JSON.stringify(live.source) === prompt.signature;
  }
  modalCurrent(modal) {
    return !this.disposed && this.modal === modal && (modal.sessionId === void 0 || modal.sessionId === (this.backend.state.session?.id ?? null)) && (modal.owner ? this.current(modal.owner) : !this.livePrompt());
  }
  focus() {
    if (this.disposed || this.modal) return;
    this.composer.ui.setFocus(this.prompt?.component ?? this.composer.editor);
  }
  showModal(create, owner2, sessionId) {
    if (this.disposed || (owner2 ? !this.current(owner2) : !!this.livePrompt())) return Promise.resolve(void 0);
    this.modal?.cancel();
    const { promise, resolve: resolve3 } = Promise.withResolvers();
    let modal;
    let closed = false;
    const finish = (value) => {
      if (closed) return;
      closed = true;
      const valid = this.modalCurrent(modal);
      if (this.modal === modal) this.modal = void 0;
      modal.handle.hide();
      modal.component.dispose?.();
      this.focus();
      resolve3(valid ? value : void 0);
      if (!this.disposed) this.options.onChange();
    };
    const component = create({
      finish,
      active: () => !closed && this.modalCurrent(modal),
      replace: (replacement) => {
        if (closed || !this.modalCurrent(modal)) {
          replacement.dispose?.();
          return;
        }
        modal.handle.hide();
        modal.component.dispose?.();
        modal.component = replacement;
        modal.handle = this.composer.ui.showOverlay(replacement, { width: "90%", maxHeight: "90%" });
        this.options.onChange();
      }
    });
    modal = {
      component,
      owner: owner2,
      sessionId,
      cancel: () => finish(void 0),
      handle: this.composer.ui.showOverlay(component, { width: "90%", maxHeight: "90%" })
    };
    this.modal = modal;
    this.options.onChange();
    return promise;
  }
  edit(title, initial, detail, owner2, promptStyle = false) {
    return this.showModal((controls) => new HookEditorComponent(
      this.composer.ui,
      title,
      initial,
      (value) => {
        if (controls.active()) controls.finish(value);
      },
      () => controls.finish(void 0),
      { question: detail, promptStyle }
    ), owner2);
  }
  choiceRows(choices) {
    const used = /* @__PURE__ */ new Set();
    return choices.map((choice) => {
      let label = choice.label;
      let suffix = 2;
      while (used.has(label)) label = `${choice.label} [${suffix++}]`;
      used.add(label);
      const description = [choice.description, choice.disabledReason].filter(Boolean).join("\n");
      return { label, ...description ? { description } : {} };
    });
  }
  replacePrompt(prompt, component) {
    if (!this.current(prompt)) {
      component.dispose?.();
      return;
    }
    const previous = prompt.component;
    prompt.component = component;
    previous?.dispose?.();
    this.focus();
  }
  approvalChoices(prompt) {
    if (!this.current(prompt)) return;
    const request = prompt.source;
    const text2 = dictionary(this.options.locale());
    const offered = request.options.map((option) => ({ ...option }));
    const choices = offered.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.persistent ? text2.persistentHint : void 0,
      disabledReason: option.disabledReason ?? (option.value.startsWith("proceed_new_session") ? "Droid SDK cannot identify a new implementation session. Use an offered current-session outcome." : void 0)
    }));
    const rows = this.choiceRows(choices);
    prompt.processing = false;
    const selector = new HookSelectorComponent(
      [
        request.title,
        request.detail,
        request.plan,
        offered.some((option) => option.persistent) ? text2.persistentHint : "",
        offered.length ? "" : text2.noPermissions
      ].filter(Boolean).join("\n\n"),
      rows,
      (label) => {
        if (!this.current(prompt) || prompt.component !== selector || prompt.processing) return;
        const index = rows.findIndex((row) => row.label === label);
        const option = offered[index];
        if (!option || choices[index]?.disabledReason) return;
        prompt.processing = true;
        if (option.value === "cancel") {
          this.settleApproval(prompt, option);
          return;
        }
        if (option.value === "proceed_edit") {
          void this.edit(text2.editPlanHint, request.plan ?? "", request.detail, prompt).then((content) => {
            if (!this.current(prompt)) return;
            if (content === void 0) {
              this.approvalChoices(prompt);
              this.options.onChange();
              return;
            }
            if (!content.trim()) {
              this.options.onError(new Error(this.options.locale() === "zh-CN" ? "\u4FEE\u6539\u540E\u7684\u8BA1\u5212\u4E0D\u80FD\u4E3A\u7A7A\u3002" : "The edited plan cannot be empty."));
              this.approvalChoices(prompt);
            } else this.approvalConfirmation(prompt, option, content);
            this.options.onChange();
          });
        } else {
          this.approvalConfirmation(prompt, option);
          this.options.onChange();
        }
      },
      () => {
        if (!this.current(prompt) || prompt.component !== selector || prompt.processing) return;
        const cancel = offered.find((option) => option.value === "cancel" && !option.disabledReason);
        if (cancel) this.settleApproval(prompt, cancel);
        else void this.backend.interrupt().catch((error) => this.options.onError(error));
      },
      {
        tui: this.composer.ui,
        inline: true,
        disabledIndices: choices.flatMap((choice, index) => choice.disabledReason ? [index] : [])
      }
    );
    this.replacePrompt(prompt, selector);
  }
  approvalConfirmation(prompt, option, edited) {
    const request = prompt.source;
    const text2 = dictionary(this.options.locale());
    const full = [
      request.title,
      option.label,
      request.detail,
      edited ?? request.plan,
      request.plan ? text2.planHint : "",
      option.persistent ? text2.persistentHint : ""
    ].filter(Boolean).join("\n\n");
    const confirmation = new ApprovalDialogComponent(full, {
      onApprove: () => {
        if (prompt.component === confirmation) this.settleApproval(prompt, option, edited);
      },
      onDeny: () => {
        if (!this.current(prompt) || prompt.component !== confirmation) return;
        this.approvalChoices(prompt);
        this.options.onChange();
      }
    }, { tui: this.composer.ui, fullPrompt: full });
    this.replacePrompt(prompt, confirmation);
  }
  settleApproval(prompt, option, edited) {
    if (!this.current(prompt)) return;
    const request = prompt.source;
    if (!request.options.some((offered) => offered.value === option.value && !offered.disabledReason) || option.value.startsWith("proceed_new_session") || option.value === "proceed_edit" && !edited?.trim()) return;
    prompt.settled = true;
    try {
      this.backend.resolveApproval(request.id, option.value, edited);
    } catch (error) {
      this.options.onError(error);
    }
    this.options.onChange();
  }
  questions(prompt, collected = /* @__PURE__ */ new Map()) {
    if (!this.current(prompt)) return;
    const request = prompt.source;
    const remaining = request.questions.flatMap((question, position) => {
      const id = String(position);
      return collected.has(id) ? [] : [{
        id,
        question: question.question,
        header: question.topic,
        options: question.options.map((label) => ({ label })),
        multi: question.multiSelect
      }];
    });
    const dialog = new AskDialogComponent(remaining, {
      onSubmit: (result2) => {
        if (!this.current(prompt) || prompt.component !== dialog) return;
        this.collectAnswers(request, result2, collected);
        if (collected.size !== request.questions.length) {
          this.options.onError(new Error(this.options.locale() === "zh-CN" ? "\u8BF7\u56DE\u7B54\u5269\u4F59\u95EE\u9898\uFF0C\u6216\u53D6\u6D88\u6574\u4E2A\u95EE\u5377\u3002" : "Answer the remaining questions, or cancel the questionnaire."));
          this.questions(prompt, collected);
          this.options.onChange();
          return;
        }
        prompt.settled = true;
        try {
          this.backend.resolveQuestion(request.id, request.questions.map((_, position) => collected.get(String(position))));
        } catch (error) {
          this.options.onError(error);
        }
        this.options.onChange();
      },
      onCancel: () => {
        if (!this.current(prompt) || prompt.component !== dialog) return;
        prompt.settled = true;
        try {
          this.backend.resolveQuestion(request.id, null);
        } catch (error) {
          this.options.onError(error);
        }
        this.options.onChange();
      },
      onPrompt: (question, prefill) => {
        if (!this.current(prompt) || prompt.component !== dialog) return Promise.resolve(void 0);
        return this.edit(question.title, prefill, question.question, prompt, true);
      }
    }, { tui: this.composer.ui });
    this.replacePrompt(prompt, dialog);
  }
  collectAnswers(request, result2, collected) {
    for (const response of result2.results) {
      const position = Number(response.id);
      const question = request.questions[position];
      if (!question || String(position) !== response.id || response.question !== question.question) continue;
      const selected = response.selectedOptions.filter((option) => question.options.includes(option));
      const parts = [...selected];
      if (response.customInput?.trim()) parts.push(response.customInput);
      if (!parts.length) continue;
      if (response.note?.trim()) parts.push(response.note);
      collected.set(response.id, { index: question.index, question: question.question, answer: parts.join("\n") });
    }
  }
};

// src/omp-todos.ts
import { Text as Text4 } from "@oh-my-pi/pi-tui/components/text";
import { EMPTY_NODE, node as node2, stableKey } from "@oh-my-pi/pi-tui/native/describe";
import { todoChecklistPhases } from "@oh-my-pi/pi-tui/tools/todo";

// src/droid-todos.ts
function parseDroidTodos(args) {
  let source;
  try {
    source = record(JSON.parse(args)).todos;
  } catch {
    return void 0;
  }
  if (typeof source !== "string") return void 0;
  const tasks = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(?:\d+\.\s*)?\[(pending|in_progress|completed)\]\s+(.+?)\s*$/.exec(line);
    if (match) {
      tasks.push({ content: match[2], status: match[1] });
    } else if (/^\s+\S/.test(line) && !/^\s*(?:\d+\.\s*)?\[/.test(line) && tasks.length) {
      tasks[tasks.length - 1].content += `
${line.trim()}`;
    } else return void 0;
  }
  return tasks;
}
function latestDroidTodo(messages) {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];
    if (message.role !== "assistant") continue;
    for (let b = message.blocks.length - 1; b >= 0; b--) {
      const block = message.blocks[b];
      if (block.kind === "tool" && block.name === "TodoWrite" && block.status === "done" && block.resultReceived) return block;
    }
  }
  return void 0;
}

// src/omp-todos.ts
var DroidTodoHud = class extends Text4 {
  native = EMPTY_NODE;
  source;
  locale;
  sessionId;
  constructor() {
    super("", 0, 0);
  }
  sync(state, locale) {
    const sessionId = state.session?.id ?? null;
    const source = sessionId ? latestDroidTodo(state.messages)?.args : void 0;
    if (this.source === source && this.locale === locale && this.sessionId === sessionId) return;
    this.source = source;
    this.locale = locale;
    this.sessionId = sessionId;
    const tasks = source === void 0 ? void 0 : parseDroidTodos(source);
    this.native = tasks?.length ? node2("checklist", {
      mode: "hud",
      role: "omp.todo.hud",
      phases: todoChecklistPhases([{ name: dictionary(locale).tasks, tasks }])
    }, void 0, stableKey(sessionId)) : EMPTY_NODE;
    this.setText(tasks?.map((task) => `${task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[>]" : "[ ]"} ${task.content}`).join("\n") ?? "");
  }
  hasTasks() {
    return this.native !== EMPTY_NODE;
  }
  describe() {
    return this.native;
  }
};

// src/omp-working.ts
import { Text as Text5 } from "@oh-my-pi/pi-tui/components/text";
import { describeWorkingRow } from "@oh-my-pi/pi-tui/components/loader";
import { col as col3, node as node3, EMPTY_NODE as EMPTY_NODE2 } from "@oh-my-pi/pi-tui/native/describe";

// src/work-state.ts
var IDLE = Object.freeze({ active: false });
function isDroidWorking(state) {
  return state.session !== null && (state.phase === "running" || state.phase === "stopping");
}
var DroidWorkTracker = class {
  sessionId;
  startedAt;
  lastTool;
  lastArgs;
  lastName;
  toolStep;
  snapshot = IDLE;
  sync(state, now = Date.now()) {
    const sessionId = state.session?.id ?? null;
    if (sessionId !== this.sessionId || !["running", "stopping", "approval", "question"].includes(state.phase)) {
      this.sessionId = sessionId;
      this.startedAt = void 0;
      this.lastTool = void 0;
      this.lastArgs = void 0;
      this.lastName = void 0;
      this.toolStep = void 0;
    }
    if (!isDroidWorking(state)) return this.snapshot = IDLE;
    this.startedAt ??= now;
    let tool;
    let latest;
    let thinking = false;
    let liveReply = false;
    for (let m = state.messages.length - 1; m >= 0; m--) {
      const message = state.messages[m];
      if (message.role === "user") break;
      if (message.role !== "assistant") continue;
      if (!latest) {
        latest = message.blocks.at(-1);
        thinking = message.streaming === true && latest?.kind === "thinking";
        liveReply = message.streaming !== void 0 && latest?.kind === "text";
      }
      for (let b = message.blocks.length - 1; b >= 0; b--) {
        const block = message.blocks[b];
        if (block.kind === "tool" && block.status === "running" && !block.resultReceived) {
          tool = block;
          break;
        }
      }
      if (tool) break;
    }
    if (tool && (tool !== this.lastTool || tool.args !== this.lastArgs || tool.name !== this.lastName)) {
      this.lastTool = tool;
      this.lastArgs = tool.args;
      this.lastName = tool.name;
      let summary;
      try {
        summary = record(JSON.parse(tool.args)).summary;
      } catch {
      }
      this.toolStep = typeof summary === "string" && summary.trim() ? summary : tool.name;
    }
    const stage = state.phase === "stopping" ? "stopping" : state.workingState === "compacting_conversation" ? "compaction" : tool ? "tool" : thinking || state.workingState === "thinking" ? "thinking" : "response";
    const step = stage === "tool" ? this.toolStep : stage === "response" && liveReply && latest?.kind === "text" ? latest.text.trim().split(/\r?\n/, 1)[0] || void 0 : void 0;
    const previous = this.snapshot;
    if (previous.active && previous.startedAt === this.startedAt && previous.stage === stage && previous.step === step) return previous;
    return this.snapshot = { active: true, startedAt: this.startedAt, stage, ...step ? { step } : {} };
  }
};

// src/omp-working.ts
var DroidWorkingHud = class extends Text5 {
  constructor(todos) {
    super("", 0, 0);
    this.todos = todos;
  }
  tracker = new DroidWorkTracker();
  snapshot = { active: false };
  locale;
  label = "";
  native;
  sync(state, locale) {
    const snapshot = this.tracker.sync(state);
    if (snapshot === this.snapshot && locale === this.locale) return;
    this.snapshot = snapshot;
    this.locale = locale;
    this.native = void 0;
    const t = dictionary(locale);
    this.label = !snapshot.active ? "" : snapshot.stage === "stopping" ? t.stop : snapshot.stage === "compaction" ? t.workingCompaction : snapshot.step ?? (snapshot.stage === "thinking" ? t.workingThinking : t.working);
    this.setText(this.label);
  }
  describe(cx) {
    if (!this.snapshot.active) return this.todos.hasTasks() ? node3("row", { role: "omp.hud", justify: "end", gap: "sm" }, [this.todos]) : EMPTY_NODE2;
    if (!this.native) {
      const original = describeWorkingRow({
        label: this.label,
        startedAt: this.snapshot.startedAt,
        ...this.snapshot.stage === "compaction" ? { variant: { kind: "compaction" } } : {}
      }, cx);
      const working = original.k === "row" ? { ...original, p: { ...original.p, grow: 1, basis: "content", min: { w: 0 } } } : original;
      this.native = col3([
        node3("row", { align: "center", gap: "sm", wrap: true }, [
          working,
          this.todos
        ])
      ], { role: "omp.hud.status" });
    }
    return this.native;
  }
};

// src/omp-images.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readImageFromClipboard, readTextFromClipboard } from "@oh-my-pi/pi-natives/clipboard";
import { parseImageMetadata } from "@oh-my-pi/pi-utils/mime";
import { imageDecodeFailureReason, MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-tui/chat/image-loading";
import { chipLabel, compactImageMarkers, formatVisionMarker, PLACEHOLDER_REGEX } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { extractImagePastePathsFromText, extractImagePathFromText } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { cachedImageDimensions, setCachedImageDimensions } from "@oh-my-pi/pi-tui/prompt/image-references";
import { tagImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
var AttachmentError = class extends Error {
  constructor(key) {
    super(key);
    this.key = key;
  }
};
var DroidImageComposer = class {
  constructor(editor, options) {
    this.editor = editor;
    this.options = options;
    this.#rawDraft = editor.getText();
    this.#originalChange = editor.onChange;
    this.#originalSubmit = editor.onSubmit;
    this.#originalPasteImage = editor.onPasteImage;
    this.#originalPastePath = editor.onPasteImagePath;
    this.#originalClearPasteState = editor.clearPasteState;
    this.#originalHandleInput = editor.handleInput;
    this.#originalHandleDraftEdit = editor.handleDraftEdit;
    editor.handleInput = this.#handleInput;
    editor.handleDraftEdit = this.#handleDraftEdit;
    editor.clearPasteState = this.#clearPasteState;
    editor.onChange = this.#change;
    editor.onSubmit = this.#submit;
    editor.onPasteImage = this.#pasteImage;
    editor.onPasteImagePath = this.#pastePath;
  }
  #submissions = /* @__PURE__ */ new WeakMap();
  #inputLifetime = new AsyncLocalStorage();
  #originalHandleInput;
  #originalHandleDraftEdit;
  #originalChange;
  #originalSubmit;
  #originalPasteImage;
  #originalPastePath;
  #originalClearPasteState;
  #rawDraft;
  #restoringDraft;
  #generation = 0;
  #disposed = false;
  #transition;
  #pendingAttachments = 0;
  #lifetime() {
    return { generation: this.#generation, session: this.options.currentSession(), cwd: this.options.cwd(), transition: this.#transition };
  }
  #alive(lifetime) {
    const transition = lifetime.transition;
    return !this.#disposed && lifetime.generation === this.#generation && (transition?.active || (transition ? transition.session : lifetime.session) === this.options.currentSession() && (transition ? transition.cwd : lifetime.cwd) === this.options.cwd());
  }
  #report(error, fallback) {
    this.options.onError(new Error(dictionary(this.options.locale())[error instanceof AttachmentError ? error.key : fallback]));
  }
  // Editor.#submitValue empties its buffer, calls this public hook, then emits
  // onChange/onSubmit. Defer only that clearing so the original private paste
  // table and atom expansions survive; rebuilding from expanded text loses chips.
  #clearPasteState = () => {
    if (!this.#disposed && this.#rawDraft !== "" && this.editor.getText() === "") {
      this.#restoringDraft = this.#rawDraft;
      return;
    }
    this.#originalClearPasteState.call(this.editor);
  };
  #change = (text2) => {
    if (this.#restoringDraft !== void 0 && text2 === "") return;
    this.#rawDraft = text2;
    this.#originalChange?.(text2);
    this.options.onChange();
  };
  #submit = (text2) => {
    const submission = this.captureSubmission(text2);
    this.options.onSubmit(submission);
  };
  // The native multi-path router awaits each load before calling the next hook.
  // Its complete async chain must retain the originating session, not re-sample
  // the newly opened session halfway through a dropped group of files.
  #handleInput = (data) => {
    this.#inputLifetime.run(this.#lifetime(), () => this.#originalHandleInput.call(this.editor, data));
  };
  #handleDraftEdit = (data) => {
    this.#inputLifetime.run(this.#lifetime(), () => this.#originalHandleDraftEdit.call(this.editor, data));
  };
  #pastePath = (path) => this.#loadPath(path, this.#inputLifetime.getStore() ?? this.#lifetime());
  #pasteImage = () => this.pasteClipboard();
  /** Called synchronously from omp's onSubmit; restores the untouched chip draft. */
  captureSubmission(message) {
    const rawDraft = this.#restoringDraft;
    this.#restoringDraft = void 0;
    if (rawDraft !== void 0) this.editor.setText(rawDraft);
    const compacted = compactImageMarkers(message, this.editor.pendingImages.length, { byAppearance: true });
    const retained = compacted ? compacted.keep.map((index) => this.editor.pendingImages[index]) : this.editor.pendingImages;
    const expanded = compacted?.text ?? message;
    const text2 = expanded.replace(PLACEHOLDER_REGEX, (marker, kind, index) => kind === "Image" && Number(index) <= retained.length ? "" : marker).trim();
    const images = Object.freeze(retained.map((image) => {
      if (!image || !isInputMime(image.mimeType)) throw new AttachmentError("imageInvalid");
      return Object.freeze({ data: image.data, mimeType: image.mimeType });
    }));
    const submission = Object.freeze({ text: text2, images });
    this.#submissions.set(submission, {
      ...this.#lifetime(),
      revision: this.editor.textRevision,
      atomsRevision: this.editor.atomsRevision,
      images: [...this.editor.pendingImages],
      historyText: message
    });
    return submission;
  }
  /** Only actual backend acceptance may commit history and clear this exact draft. */
  accept(submission) {
    const state = this.#submissions.get(submission);
    this.#submissions.delete(submission);
    if (!state || !this.#alive(state)) return false;
    if (state.revision !== this.editor.textRevision || state.atomsRevision !== this.editor.atomsRevision || state.images.length !== this.editor.pendingImages.length || state.images.some((image, index) => image !== this.editor.pendingImages[index])) {
      this.editor.addToHistory(state.historyText);
      return false;
    }
    this.editor.clearDraft(state.historyText);
    this.options.onChange();
    return true;
  }
  hasAttachments() {
    return this.editor.composerChips().some((chip) => chip.kind === "image");
  }
  /** Detach the old draft while a session opens, without destroying native paste tables. */
  beginSessionChange() {
    let previous = {
      text: this.editor.getText(),
      images: this.editor.pendingImages,
      links: this.editor.pendingImageLinks,
      imageLinks: this.editor.imageLinks,
      texts: this.editor.pendingTexts
    };
    const generation = ++this.#generation;
    this.#pendingAttachments = 0;
    this.#restoringDraft = void 0;
    const transition = {
      active: true,
      session: this.options.currentSession(),
      cwd: this.options.cwd()
    };
    this.#transition = transition;
    this.editor.pendingImages = [];
    this.editor.pendingImageLinks = [];
    this.editor.imageLinks = void 0;
    this.editor.pendingTexts = [];
    this.editor.setText("");
    const revision = this.editor.textRevision;
    const atomsRevision = this.editor.atomsRevision;
    let settled = false;
    const finish = (restore) => {
      if (settled) return;
      settled = true;
      transition.active = false;
      transition.session = this.options.currentSession();
      transition.cwd = this.options.cwd();
      if (this.#transition === transition) this.#transition = void 0;
      if (!this.#disposed && generation === this.#generation) {
        const unchanged = revision === this.editor.textRevision && atomsRevision === this.editor.atomsRevision && this.#pendingAttachments === 0;
        if (restore && unchanged && previous) {
          this.editor.pendingImages = previous.images;
          this.editor.pendingImageLinks = previous.links;
          this.editor.imageLinks = previous.imageLinks;
          this.editor.pendingTexts = previous.texts;
          this.editor.setText(previous.text);
        } else if (unchanged) {
          this.#originalClearPasteState.call(this.editor);
        }
        this.options.onChange();
      }
      previous = void 0;
    };
    return { complete: () => finish(false), rollback: () => finish(true) };
  }
  /** Call only after a session change succeeds; also fences work from the old session. */
  resetSession() {
    this.#generation++;
    this.#transition = void 0;
    this.#pendingAttachments = 0;
    this.#restoringDraft = void 0;
    this.editor.clearDraft();
    this.options.onChange();
  }
  async #loadPath(path, lifetime) {
    if (!this.#alive(lifetime)) return;
    this.#pendingAttachments++;
    try {
      const extracted = extractImagePathFromText(path) ?? path.trim();
      const normalized = extracted.length > 1 && (extracted[0] === '"' || extracted[0] === "'") && extracted.at(-1) === extracted[0] ? extracted.slice(1, -1) : extracted;
      const localPath = normalized.startsWith("file:") ? fileURLToPath(normalized) : normalized;
      if (!localPath || localPath.includes("\0") || /^[a-z][a-z\d+.-]*:/i.test(localPath)) throw new AttachmentError("imagePathInvalid");
      const fullPath = resolve(lifetime.cwd, localPath.startsWith("~/") ? resolve(homedir(), localPath.slice(2)) : localPath);
      const file = await open(fullPath, constants.O_RDONLY | constants.O_NONBLOCK);
      let bytes;
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new AttachmentError("imagePathInvalid");
        if (stat.size > MAX_IMAGE_INPUT_BYTES) throw new AttachmentError("imageTooLarge");
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
      if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new AttachmentError("imageTooLarge");
      if (!this.#alive(lifetime)) return;
      const image = await decodedImage(bytes, fullPath);
      if (!this.#alive(lifetime)) return;
      this.#attach(image, fullPath);
    } catch (error) {
      if (this.#alive(lifetime)) this.#report(error, "imagePathInvalid");
    } finally {
      if (lifetime.generation === this.#generation) this.#pendingAttachments--;
    }
  }
  /** Invoked only by an explicit native paste action, never at startup. */
  async pasteClipboard() {
    const lifetime = this.#inputLifetime.getStore() ?? this.#lifetime();
    if (!this.#alive(lifetime)) return false;
    this.#pendingAttachments++;
    try {
      let text2;
      let textFailed = false;
      try {
        text2 = await readTextFromClipboard();
      } catch {
        textFailed = true;
      }
      if (!this.#alive(lifetime)) return false;
      const paths = text2 ? extractImagePastePathsFromText(text2) : void 0;
      if (paths?.length) {
        for (const path of paths) {
          if (!this.#alive(lifetime)) return false;
          await this.#loadPath(path, lifetime);
        }
        return true;
      }
      let imageFailed = false;
      let clipboard;
      try {
        clipboard = await readImageFromClipboard();
      } catch {
        imageFailed = true;
      }
      if (!this.#alive(lifetime)) return false;
      if (clipboard) {
        const image = await decodedImage(clipboard.data);
        if (!this.#alive(lifetime)) return false;
        this.#attach(image);
        return true;
      }
      if (text2) {
        this.editor.pasteText(text2);
        this.options.onChange();
        return true;
      }
      if (textFailed || imageFailed) throw new AttachmentError("imageClipboardFailed");
      return false;
    } catch (error) {
      if (this.#alive(lifetime)) this.#report(error, "imageClipboardFailed");
      return false;
    } finally {
      if (lifetime.generation === this.#generation) this.#pendingAttachments--;
    }
  }
  #attach(image, path) {
    const dims = cachedImageDimensions(image) ?? void 0;
    this.editor.pendingImages.push(image);
    this.editor.pendingImageLinks.push(path);
    this.editor.imageLinks = this.editor.pendingImageLinks;
    const n = this.editor.pendingImages.length;
    this.editor.insertAtom(chipLabel("image", n), formatVisionMarker("image", n, dims));
    this.options.onChange();
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation++;
    if (this.editor.clearPasteState === this.#clearPasteState) this.editor.clearPasteState = this.#originalClearPasteState;
    if (this.editor.onChange === this.#change) this.editor.onChange = this.#originalChange;
    if (this.editor.onSubmit === this.#submit) this.editor.onSubmit = this.#originalSubmit;
    if (this.editor.onPasteImage === this.#pasteImage) this.editor.onPasteImage = this.#originalPasteImage;
    if (this.editor.onPasteImagePath === this.#pastePath) this.editor.onPasteImagePath = this.#originalPastePath;
    if (this.editor.handleInput === this.#handleInput) this.editor.handleInput = this.#originalHandleInput;
    if (this.editor.handleDraftEdit === this.#handleDraftEdit) this.editor.handleDraftEdit = this.#originalHandleDraftEdit;
    this.#inputLifetime.disable();
    this.editor.clearDraft();
  }
};
function isInputMime(mimeType) {
  return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/gif" || mimeType === "image/webp";
}
async function decodedImage(bytes, path) {
  if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES) throw new AttachmentError("imageTooLarge");
  const metadata = parseImageMetadata(bytes);
  if (!metadata || !isInputMime(metadata.mimeType)) throw new AttachmentError("imageInvalid");
  const image = {
    type: "image",
    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
    mimeType: metadata.mimeType
  };
  if (await imageDecodeFailureReason(image) !== null) throw new AttachmentError("imageInvalid");
  const attached = path ? tagImageAttachmentSource(image, path, "image") : image;
  setCachedImageDimensions(attached, metadata.width && metadata.height ? { width: metadata.width, height: metadata.height } : null);
  return attached;
}
function imageAdmissionError(error, locale) {
  const message = error instanceof Error ? error.message : String(error);
  const labels = dictionary(locale);
  switch (message) {
    case "The selected Droid model does not support image attachments. Choose an image-capable model or remove the images.":
      return labels.imageUnsupportedModel;
    case "Image attachments must contain valid base64 data in JPEG, PNG, GIF or WebP format.":
      return labels.imageInvalid;
    case "Enter a message or attach an image before sending.":
      return labels.imageEmptyDraft;
    default:
      return void 0;
  }
}

// src/main.ts
var { values } = parseArgs({ options: {
  cwd: { type: "string" },
  "data-dir": { type: "string" },
  droid: { type: "string" },
  session: { type: "string" },
  "pick-session": { type: "boolean" },
  locale: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" }
} });
if (values.help || values.version) {
  process.stdout.write(values.version ? "tern-bridge-droid 0.1.0\n" : "tern-bridge-droid \u2014 Droid with the original omp UI components\n\nUsage: bun dist/client.mjs [--cwd DIR] [--data-dir DIR] [--session ID | --pick-session]\n       [--droid PATH] [--locale zh-CN|en-US]\n\nRequires Bun 1.3.14+, Tern native surfaces and an authenticated Droid CLI.\nNo model request is made until you send a message or explicitly compact context.\n");
} else await run();
async function run() {
  if (values.locale && values.locale !== "zh-CN" && values.locale !== "en-US") throw new Error("--locale must be zh-CN or en-US");
  if (values.session && values["pick-session"]) throw new Error("Choose --session or --pick-session, not both.");
  const cwd = resolve2(values.cwd ?? process.cwd());
  const config = process.env.TERN_CONFIG_DIR ?? (process.platform === "darwin" ? join2(homedir2(), "Library", "Application Support", "Tern") : join2(process.env.XDG_STATE_HOME ?? join2(homedir2(), ".local", "state"), "tern"));
  const dataDir = resolve2(values["data-dir"] ?? join2(config, "plugin-data", "tern-bridge-droid"));
  let preferences = {};
  try {
    const saved = JSON.parse(await readFile2(join2(dataDir, "preferences.json"), "utf8"));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) preferences = saved;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  let locale = values.locale === "en-US" || !values.locale && preferences.locale === "en-US" ? "en-US" : "zh-CN";
  const text2 = (zh2, en2) => locale === "zh-CN" ? zh2 : en2;
  if (process.env.TERM_PROGRAM?.toLowerCase() !== "tern" || !process.stdin.isTTY) {
    process.stderr.write(text2("\u8BF7\u5728 Tern \u7684\u672C\u673A\u7A97\u683C\u4E2D\u6253\u5F00\u6B64\u5BA2\u6237\u7AEF\u3002\n", "Open this client in a local Tern pane.\n"));
    process.exitCode = 1;
    return;
  }
  delete process.env.FACTORY_DROID_SDK_TRANSPORT_LOG;
  delete process.env.PI_TUI_TSP_RECORD;
  process.title = "tern-bridge-droid";
  const ended = Promise.withResolvers();
  let closing = false;
  let scheduled = false;
  let submitting = false;
  let terminalProgress = false;
  let pendingNew = null;
  let uiError = null;
  let observedBackendError = null;
  let dismissedBackendError = null;
  let banner;
  let bannerMessage = null;
  let mountedPrompt;
  let facts;
  let factsKey = "";
  let expanded = false;
  let autocompleteCwd = "";
  const notice = new Text6("");
  const identity = new Text6("Droid");
  const composer = new Composer({ preferences: { quiet: true, spellingAutocomplete: "off", spellingTypoDetection: false }, exit: (code2) => {
    process.exitCode = code2;
    void shutdown();
  } });
  const backend = new DroidBridge({ cwd, dataDir, execPath: values.droid ?? (typeof preferences.droidPath === "string" ? preferences.droidPath : void 0), onChange: changed });
  const transcript = new DroidTranscript(composer.ui, cwd);
  const todos = new DroidTodoHud();
  const working = new DroidWorkingHud(todos);
  const dialogs = new DroidDialogs(composer, backend, { locale: () => locale, onError: report, onChange: changed, openSession: (id) => open2(id) });
  composer.setHeaderExtras([identity], []);
  composer.editor.magicKeywordsEnabledOverride = false;
  composer.editor.attachmentChips = new AttachmentChipsBand(composer.editor, composer.ui.imageBudget, () => composer.ui.requestRender());
  composer.editor.composerState = () => ({ running: busy(), thinking: backend.state.session?.settings.reasoningEffort, title: backend.state.session?.title || void 0 });
  composer.editor.composerFacts = {
    describeComposerFacts: () => facts,
    handleNativeEvent(event) {
      if (event.type === "action" && event.act.startsWith("status.")) void perform(() => command(event.act.slice(7)));
    }
  };
  const images = new DroidImageComposer(composer.editor, {
    locale: () => locale,
    currentSession: () => backend.state.session?.id ?? null,
    cwd: () => backend.state.session?.cwd ?? cwd,
    onChange: changed,
    onError: report,
    onSubmit: (submission) => {
      void perform(() => submit(submission));
    }
  });
  composer.editor.onEscape = () => {
    void perform(() => busy() ? backend.interrupt() : Promise.resolve());
  };
  composer.editor.onClear = () => {
    if (busy()) void perform(() => backend.interrupt());
    else composer.editor.clearDraft();
  };
  composer.editor.onExit = () => {
    void perform(() => command("quit"));
  };
  composer.editor.onSelectModel = composer.editor.onSelectModelTemporary = () => {
    void perform(() => command("model"));
  };
  composer.editor.onCycleThinkingLevel = () => {
    void perform(() => command("reasoning"));
  };
  composer.editor.onRetry = () => {
    void perform(() => command("retry"));
  };
  composer.editor.setCustomKeyHandler("ctrl+alt+shift+o", () => {
    void perform(() => dialogs.sessions());
  });
  composer.editor.setCustomKeyHandler("ctrl+alt+shift+n", () => {
    void perform(() => command("new"));
  });
  composer.editor.setCustomKeyHandler("ctrl+o", () => {
    expanded = !expanded;
    transcript.setExpanded(expanded);
    changed();
  });
  const commands = [
    { name: "sessions", get description() {
      return dictionary(locale).sessions;
    } },
    { name: "new", description: "Droid: new conversation" },
    { name: "resume", description: "Droid: saved conversations" },
    { name: "model", description: "Droid: select model" },
    { name: "reasoning", description: "Droid: reasoning effort" },
    { name: "mode", description: "Droid: Auto / Spec" },
    { name: "autonomy", description: "Droid: approval policy" },
    { name: "rename", description: "Droid: rename conversation" },
    { name: "fork", description: "Droid: fork conversation" },
    { name: "compact", description: "Droid: compact context (may use model quota)" },
    { name: "rewind", description: "Droid: inspect rewind" },
    { name: "context", description: "Droid: context usage breakdown" },
    { name: "retry", description: "Droid: reconnect without replay" },
    { name: "language", description: "Bridge: \u4E2D\u6587 / English" },
    { name: "help", description: "Bridge: conversation actions" },
    { name: "quit", description: "Bridge: close client" }
  ];
  const nativeChange = onNativeRenderingChange((on) => {
    if (on) {
      composer.ui.terminal.setTitle("Droid");
      composer.ui.terminal.write(`${TSP_PREFIX}s;{"name":"droid-composer","css":".sf-place{display:none}"}\x1B\\`);
    }
  });
  function busy() {
    return submitting || backend.state.needsInterrupt || ["connecting", "running", "approval", "question", "stopping"].includes(backend.state.phase);
  }
  function report(error) {
    if (closing) return;
    uiError = imageAdmissionError(error, locale) ?? (error instanceof Error ? error.message : String(error));
    pendingNew = null;
    changed();
  }
  async function perform(work) {
    uiError = null;
    try {
      await work();
    } catch (error) {
      report(error);
    }
    changed();
  }
  function changed() {
    if (closing || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closing) return;
      try {
        update();
      } catch {
        process.exitCode = 1;
        process.stderr.write("Droid UI rendering failed. Saved messages were not replayed. Reopen the saved session.\n");
        void shutdown();
        return;
      }
      if (pendingNew) {
        if (backend.state.session?.id !== pendingNew || backend.state.phase === "error") pendingNew = null;
        else if (!busy() && backend.state.phase === "idle") {
          pendingNew = null;
          void perform(() => open2());
        }
      }
    });
  }
  function update() {
    const active = isDroidWorking(backend.state);
    if (terminalProgress !== active) {
      terminalProgress = active;
      composer.ui.terminal.setProgress(active);
    }
    const b = backend.state;
    const t = dictionary(locale);
    const activeCwd = b.session?.cwd || cwd;
    if (activeCwd !== autocompleteCwd) {
      autocompleteCwd = activeCwd;
      composer.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, activeCwd));
    }
    if (b.error !== observedBackendError) {
      observedBackendError = b.error;
      dismissedBackendError = null;
    }
    const error = uiError || (b.error === dismissedBackendError ? null : b.error);
    if (error !== bannerMessage) {
      banner?.dispose();
      bannerMessage = error;
      banner = error ? new ErrorBannerComponent(error, () => {
        uiError = null;
        dismissedBackendError = b.error;
        changed();
      }) : void 0;
    }
    identity.setText(`Droid \xB7 ${b.session?.title || t.untitled}`);
    notice.setText(b.notice ?? "");
    transcript.sync(b);
    todos.sync(b, locale);
    working.sync(b, locale);
    const prompt = dialogs.syncPrompts();
    composer.editor.disableSubmit = submitting || ["connecting", "running", "approval", "question", "stopping"].includes(b.phase) || b.needsInterrupt;
    composer.setRuntimeChildren([transcript.container, ...banner ? [banner] : [], ...b.notice ? [notice] : [], working, prompt ?? composer.editor]);
    if (prompt !== mountedPrompt) {
      mountedPrompt = prompt;
      if (!dialogs.hasOverlay()) composer.ui.setFocus(prompt ?? composer.editor);
    }
    const settings2 = b.session?.settings;
    const selected = b.models.find((model) => model.id === settings2?.modelId);
    const key = JSON.stringify([locale, b.phase, b.context, b.session?.title, selected?.label, settings2]);
    if (key !== factsKey) {
      factsKey = key;
      const mode = settings2?.interactionMode === "auto" ? "Auto" : settings2?.interactionMode === "spec" ? "Spec" : settings2?.interactionMode || t.mode;
      const autonomy = settings2?.autonomyLevel;
      const autonomyLabel = autonomy === "off" ? t.autonomyOff : autonomy === "low" ? t.autonomyLow : autonomy === "medium" ? t.autonomyMedium : autonomy === "high" ? t.autonomyHigh : autonomy || t.unknown;
      const autonomyTitle = `${t.autonomy}: ${autonomyLabel}`;
      const controls = ["error", "disconnected"].includes(b.phase) ? [actionButton2(t.reconnect, "status.retry", { key: "retry", title: t.reconnectHint })] : [
        actionButton2(mode, "status.mode", { key: "mode", title: `${t.mode}: ${mode}` }),
        node4("row", {
          role: "omp.btn",
          gap: "xs",
          align: "center",
          aria: autonomyTitle,
          title: autonomyTitle,
          actions: { click: "status.autonomy" }
        }, [node4("effort", { level: autonomy ?? "", aria: autonomyTitle }, void 0, "level")], "autonomy")
      ];
      facts = {
        context: node4("meter", {
          role: "omp.composer.context",
          style: "bar",
          actions: { click: "status.context" },
          aria: t.context,
          value: b.context && b.context.limit > 0 ? Math.min(1, b.context.used / b.context.limit) : null,
          ...b.context && b.context.limit > 0 ? { label: `${Math.round(b.context.used / b.context.limit * 100)}%` } : {},
          title: `${t.context}: ${b.context ? `${b.context.used.toLocaleString(locale)} / ${b.context.limit.toLocaleString(locale)}` : t.unknown}`
        }, void 0, "context"),
        model: { spans: [span2(`Droid \xB7 ${selected?.label || settings2?.modelId || t.default}`)], title: t.model },
        extras: node4("row", { role: "omp.composer.extras", grow: 1, gap: "xs", align: "center" }, controls, "extras"),
        usage: EMPTY_NODE3
      };
    }
    composer.ui.terminal.setTitle(`Droid \xB7 ${b.session?.title || t.untitled}`);
    composer.ui.requestRender();
  }
  async function open2(id) {
    pendingNew = null;
    if (busy()) throw new Error(text2("\u8BF7\u5148\u505C\u6B62\u5F53\u524D\u4EFB\u52A1\uFF0C\u518D\u5207\u6362\u4F1A\u8BDD\u3002", "Stop the active turn before switching conversations."));
    if (id !== void 0 && id === backend.state.session?.id) {
      await backend.open(id);
      return;
    }
    const transition = images.beginSessionChange();
    try {
      await backend.open(id);
      transition.complete();
    } catch (error) {
      transition.rollback();
      throw error;
    }
  }
  async function submit(submission) {
    const message = submission.text;
    if (!message.trim() && !submission.images.length) return;
    const match = !submission.images.length && /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(message);
    if (match && match[1] && commands.some((item) => item.name === match[1])) {
      images.accept(submission);
      await command(match[1], match[2]);
      return;
    }
    if (busy() || backend.state.phase !== "idle") throw new Error(text2("\u5F53\u524D\u65E0\u6CD5\u53D1\u9001\u3002\u8BF7\u5148\u505C\u6B62\u4EFB\u52A1\u6216\u91CD\u65B0\u8FDE\u63A5\u4F1A\u8BDD\u3002", "Cannot send now. Stop the active work or reconnect the session."));
    submitting = true;
    changed();
    try {
      await backend.send(message, () => {
        images.accept(submission);
        changed();
      }, submission.images);
    } finally {
      submitting = false;
      changed();
    }
  }
  async function command(name, argument) {
    const t = dictionary(locale);
    switch (name) {
      case "sessions":
        return dialogs.sessions();
      case "context":
        return dialogs.context();
      case "resume":
        return argument?.trim() ? open2(argument.trim()) : dialogs.sessions();
      case "help": {
        const selected = await dialogs.choose(text2("Droid \u4F1A\u8BDD\u64CD\u4F5C", "Droid conversation actions"), commands.filter((item) => item.name !== "help").map((item) => ({ value: item.name, label: `/${item.name}`, description: item.description })));
        if (selected) await command(selected);
        return;
      }
      case "new": {
        if (busy()) {
          if (!await dialogs.confirm(text2("\u505C\u6B62\u5E76\u65B0\u5EFA\u5BF9\u8BDD\uFF1F", "Stop and start a new conversation?"), text2("\u5DF2\u6267\u884C\u7684\u6587\u4EF6\u4FEE\u6539\u4E0D\u4F1A\u81EA\u52A8\u64A4\u9500\u3002", "File changes already made will not be undone."))) return;
          const source = backend.state.session?.id;
          await backend.interrupt();
          if (source && backend.state.session?.id === source) pendingNew = source;
          changed();
        } else await open2();
        return;
      }
      case "model": {
        const value = await dialogs.choose(t.model, backend.state.models.map((model) => ({ value: model.id, label: model.label, description: model.id })));
        if (value) await backend.updateSettings({ modelId: value });
        return;
      }
      case "reasoning": {
        const model = backend.state.models.find((item) => item.id === backend.state.session?.settings.modelId);
        const value = await dialogs.choose(t.reasoning, (model?.reasoningEfforts ?? []).map((value2) => ({ value: value2, label: value2 })));
        if (value) await backend.updateSettings({ reasoningEffort: value });
        return;
      }
      case "mode": {
        const value = await dialogs.choose(t.mode, [{ value: "auto", label: "Auto", description: text2("\u6267\u884C\u4EFB\u52A1\uFF0C\u4FDD\u7559\u5F53\u524D\u5BA1\u6279\u7B56\u7565\u3002", "Execute with the current approval policy.") }, { value: "spec", label: "Spec", description: text2("\u53EA\u8BFB\u5206\u6790\u5E76\u63D0\u51FA\u65B9\u6848\uFF1B\u5207\u6362\u6A21\u5F0F\u4E0D\u4EE3\u8868\u63A5\u53D7\u8BA1\u5212\u3002", "Inspect and propose a plan; switching mode does not accept a plan.") }]);
        if (value) await backend.updateSettings({ interactionMode: value });
        return;
      }
      case "autonomy": {
        const settings2 = backend.state.session?.settings;
        const levels = settings2?.availableAutonomyLevels ?? (settings2?.autonomyLevel ? [settings2.autonomyLevel] : []);
        const value = await dialogs.choose(t.autonomy, levels.map((value2) => ({ value: value2, label: value2 })));
        if (value && (value === "off" || await dialogs.confirm(t.autonomy, text2(`Droid \u5C06\u6309 ${value} \u7EA7\u522B\u81EA\u52A8\u6279\u51C6\u4E4B\u540E\u7684\u64CD\u4F5C\u3002`, `Droid will automatically approve subsequent operations allowed by ${value}.`)))) await backend.updateSettings({ autonomyLevel: value });
        return;
      }
      case "rename": {
        const value = argument ?? await dialogs.input(t.rename, backend.state.session?.title, t.renameHint);
        if (value?.trim()) await backend.rename(value);
        return;
      }
      case "fork":
        return backend.fork();
      case "compact": {
        const value = await dialogs.input(t.compact, argument, text2("\u538B\u7F29\u53EF\u80FD\u8C03\u7528\u6A21\u578B\u5E76\u6D88\u8017\u5F53\u524D Droid \u989D\u5EA6\u3002\u53EF\u586B\u5199\u989D\u5916\u8981\u6C42\u3002", "Compaction may call the selected model and use Droid quota. Extra instructions are optional."));
        if (value !== void 0) await backend.compact(value || void 0);
        return;
      }
      case "rewind": {
        const messages = backend.state.messages.filter((message) => message.role === "user");
        const target = await dialogs.choose(t.rewind, messages.map((message) => ({ value: message.id, label: message.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n") || t.user, description: message.id })));
        if (!target) return;
        const plan = await backend.prepareRewind(target);
        const details = [t.rewindDetail, ...plan.filesToRestore.map((file) => `${t.restore}: ${file.filePath} (${file.size} B)`), ...plan.filesToDelete.map((file) => `${t.remove}: ${file.filePath}`), ...plan.unavailable.map((file) => `${t.unavailable}: ${file}`)].join("\n");
        const choice = await dialogs.choose(t.rewindConfirm, [
          { value: "conversation", label: t.conversationOnly, description: details },
          { value: "files", label: t.restoreFiles, description: details, ...plan.unavailable.length || !plan.filesToRestore.length && !plan.filesToDelete.length ? { disabledReason: plan.unavailable.length ? t.unavailableHint : t.noFiles } : {} }
        ]);
        if (choice && await dialogs.confirm(t.rewindConfirm, details)) await backend.rewind(plan, choice === "files");
        return;
      }
      case "retry":
        await backend.open(backend.state.session?.id);
        return;
      case "language": {
        const value = argument ?? await dialogs.choose(t.language, [{ value: "zh-CN", label: "\u7B80\u4F53\u4E2D\u6587" }, { value: "en-US", label: "English" }]);
        if (value !== "zh-CN" && value !== "en-US") return;
        await mkdir2(dataDir, { recursive: true, mode: 448 });
        const path = join2(dataDir, "preferences.json");
        const pending = `${path}.${process.pid}.tmp`;
        await writeFile2(pending, JSON.stringify({ ...preferences, locale: value }) + "\n", { mode: 384 });
        await rename2(pending, path);
        preferences = { ...preferences, locale: value };
        locale = value;
        factsKey = "";
        return;
      }
      case "quit":
        if ((busy() || composer.editor.getText()) && !await dialogs.confirm(text2("\u5173\u95ED\u5BA2\u6237\u7AEF\uFF1F", "Close the client?"), text2("\u4F1A\u505C\u6B62\u5F53\u524D\u4EFB\u52A1\uFF0C\u672A\u53D1\u9001\u8349\u7A3F\u4E0D\u4F1A\u4FDD\u5B58\uFF1B\u5386\u53F2\u4F1A\u8BDD\u4FDD\u7559\u3002", "The active turn will stop and unsent drafts will be lost. Saved conversations remain."))) return;
        return shutdown();
    }
  }
  async function shutdown() {
    if (closing) return;
    closing = true;
    pendingNew = null;
    composer.ui.terminal.setProgress(false);
    dialogs.dispose();
    images.dispose();
    try {
      await backend.close();
    } finally {
      nativeChange();
      transcript.dispose();
      stopSharedSpinnerTicker();
      composer.stop();
      ended.resolve();
    }
  }
  const signal = () => {
    void shutdown();
  };
  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signalName, signal);
  try {
    update();
    composer.start({ clearScrollback: false, playWelcomeIntro: false, deferInput: true });
    composer.ui.releaseHeldInput();
    if (values["pick-session"]) void perform(() => dialogs.sessions());
    else void perform(() => backend.open(values.session));
    await ended.promise;
  } finally {
    for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signalName, signal);
    await shutdown();
  }
}
