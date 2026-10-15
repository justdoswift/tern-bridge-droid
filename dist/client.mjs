// src/main.ts
import { readFile as readFile2, mkdir as mkdir2, writeFile as writeFile2, rename as rename2 } from "node:fs/promises";
import { homedir } from "node:os";
import { join as join2, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { Text as Text2 } from "@oh-my-pi/pi-tui/components/text";
import { ErrorBannerComponent } from "@oh-my-pi/pi-tui/overlays/error-banner";
import { node, span } from "@oh-my-pi/pi-tui/native/describe";
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
  const code = record(error).code ?? metadata.code;
  if (code === "ENOENT" || metadata.message === "executable not found") return new BridgeFailure(`${action}: Droid could not start. Check the executable path and working directory.`);
  if (code === -32004 || name === "SessionNotFoundError") return new BridgeFailure(`${action}: the saved session was not found. Choose another session.`);
  if (name === "TimeoutError") return new BridgeFailure(`${action}: Droid did not confirm the request in time. Nothing was resubmitted; inspect the session before sending again.`);
  if (name === "ConnectionError" || name === "ProcessExitError") return new BridgeFailure(`${action}: the Droid connection ended. No prompt was replayed. Reopen the saved session after checking Droid CLI login and executable access.`);
  if (name === "ProtocolError") return new BridgeFailure(`${action}: Droid rejected the request${typeof code === "number" ? ` (code ${code})` : ""}. Check the selected session, model and CLI login.`);
  return new BridgeFailure(`${action}: Droid could not complete the operation. Check CLI login, executable access and session availability. No request was automatically retried.`);
}
function result(response) {
  const envelope = record(response);
  if (envelope.error) {
    const code = record(envelope.error).code;
    throw new BridgeFailure(`Droid rejected the request${typeof code === "number" ? ` (code ${code})` : ""}. Check session availability and the current settings.`);
  }
  if (!envelope.result || typeof envelope.result !== "object") throw new BridgeFailure("Droid returned no confirmed result. Check that the CLI supports the installed SDK.");
  return record(envelope.result);
}
function normalizeModels(value, selected) {
  const models = /* @__PURE__ */ new Map();
  if (Array.isArray(value)) for (const item of value) {
    const model = record(item);
    if (typeof model.id !== "string" || model.disabled === true) continue;
    models.set(model.id, {
      id: model.id,
      label: typeof model.displayName === "string" ? model.displayName : model.id,
      reasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.filter((effort) => typeof effort === "string") : [],
      ...typeof model.defaultReasoningEffort === "string" ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}
    });
  }
  if (selected?.modelId && !models.has(selected.modelId)) models.set(selected.modelId, { id: selected.modelId, label: selected.modelId, reasoningEfforts: selected.reasoningEffort ? [selected.reasoningEffort] : [] });
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
    needsInterrupt: false
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
  async send(text, onAccepted) {
    const scope = this.ready();
    if (!text.trim()) throw new BridgeFailure("Enter a message before sending.");
    if (this.active || this.operation || this.state.phase !== "idle") throw new BridgeFailure("Droid already has active work. Stop it or wait before sending another message.");
    if (scope.unansweredSnapshots.size) throw new BridgeFailure(PENDING_SNAPSHOT_NOTICE);
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
    this.state.error = null;
    this.state.notice = null;
    this.state.phase = "running";
    this.changed();
    try {
      await Promise.race([
        scope.client.addUserMessage({ text, messageId: turn.messageId }, turn.requestId).then(result),
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
        if (this.scope === scope) this.state.models = normalizeModels(discovered.models, this.state.session?.settings);
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
    this.state.models = normalizeModels(response.availableModels, this.state.session.settings);
    this.state.context = null;
    this.state.usage = null;
    this.usage(response.tokenUsage);
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
      if (turn?.scope === scope && !turn.accepted && typeof message.id === "string" && message.role === "user" && message.visibility !== "llm_only" && message.isUserVisible !== false && message.hiddenFromUserViews !== true && Array.isArray(message.content) && message.content.some((value2) => record(value2).type === "text") && (message.id === turn.messageId || event.requestId === turn.requestId)) {
        turn.accepted = true;
        try {
          turn.accept();
        } catch {
          this.state.notice = "Droid accepted the message, but the editor could not acknowledge it.";
        }
      }
    } else if (event.type === "settings_updated" && this.state.session) {
      this.state.session.settings = settings(event.settings, this.state.session.settings);
      this.state.models = normalizeModels(this.state.models.map((model) => ({ id: model.id, displayName: model.label, supportedReasoningEfforts: model.reasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort })), this.state.session.settings);
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
    const { promise, resolve: resolve2 } = Promise.withResolvers();
    scope.prompts.push({ kind: "approval", id, promise, settle(value2) {
      scope.permissionResults.set(id, value2);
      resolve2(value2);
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
    const { promise, resolve: resolve2 } = Promise.withResolvers();
    scope.prompts.push({ kind: "question", id, promise, settle(value2) {
      scope.questionResults.set(id, value2);
      resolve2(value2);
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
import { ensureThemeSync, getLanguageFromPath, getMarkdownTheme, getThemeEpoch, theme } from "@oh-my-pi/pi-tui/theme";
var DroidToolCard = class extends ToolExecutionComponent {
  expanded = false;
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
        this.addChild(new Image(block.data, block.mime, { fallbackColor: (text) => theme.fg("dim", text) }, {
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
    if (!this.tool) {
      this.tool = new DroidToolCard(
        block.name,
        toolArgs(block.args),
        { useBuiltInRenderer: false },
        void 0,
        this.ui,
        this.cwd,
        block.id
      );
      this.tool.setExpanded(this.expanded);
      this.addChild(this.tool);
    } else if (block.args !== previous?.args) this.tool.updateArgs(toolArgs(block.args), block.id);
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
  more: "More",
  model: "Model",
  reasoning: "Reasoning",
  mode: "Mode",
  autonomy: "Autonomy",
  default: "Default",
  send: "Send",
  stop: "Stop",
  draft: "Message Droid",
  draftHint: "Enter to send \xB7 Shift+Enter for a new line",
  empty: "Start a conversation in this project.",
  context: "Context",
  usage: "Tokens",
  input: "in",
  output: "out",
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
  more: "\u66F4\u591A",
  model: "\u6A21\u578B",
  reasoning: "\u601D\u8003\u5F3A\u5EA6",
  mode: "\u6A21\u5F0F",
  autonomy: "\u81EA\u4E3B\u6743\u9650",
  default: "\u9ED8\u8BA4",
  send: "\u53D1\u9001",
  stop: "\u505C\u6B62",
  draft: "\u7ED9 Droid \u53D1\u6D88\u606F",
  draftHint: "Enter \u53D1\u9001 \xB7 Shift+Enter \u6362\u884C",
  empty: "\u5728\u5F53\u524D\u9879\u76EE\u5F00\u59CB\u5BF9\u8BDD\u3002",
  context: "\u4E0A\u4E0B\u6587",
  usage: "Token",
  input: "\u8F93\u5165",
  output: "\u8F93\u51FA",
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
      const text = dictionary(this.options.locale());
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
          title: loading ? text.loading : text.sessions,
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
        component.loadingMessage = loading ? text.loading : void 0;
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
            `${text.sessions}
${error instanceof Error ? error.message : String(error)}`,
            [retry, text.cancel],
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
    return !this.disposed && this.modal === modal && (modal.owner ? this.current(modal.owner) : !this.livePrompt());
  }
  focus() {
    if (this.disposed || this.modal) return;
    this.composer.ui.setFocus(this.prompt?.component ?? this.composer.editor);
  }
  showModal(create, owner2) {
    if (this.disposed || (owner2 ? !this.current(owner2) : !!this.livePrompt())) return Promise.resolve(void 0);
    this.modal?.cancel();
    const { promise, resolve: resolve2 } = Promise.withResolvers();
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
      resolve2(valid ? value : void 0);
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
    const text = dictionary(this.options.locale());
    const offered = request.options.map((option) => ({ ...option }));
    const choices = offered.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.persistent ? text.persistentHint : void 0,
      disabledReason: option.disabledReason ?? (option.value.startsWith("proceed_new_session") ? "Droid SDK cannot identify a new implementation session. Use an offered current-session outcome." : void 0)
    }));
    const rows = this.choiceRows(choices);
    prompt.processing = false;
    const selector = new HookSelectorComponent(
      [
        request.title,
        request.detail,
        request.plan,
        offered.some((option) => option.persistent) ? text.persistentHint : "",
        offered.length ? "" : text.noPermissions
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
          void this.edit(text.editPlanHint, request.plan ?? "", request.detail, prompt).then((content) => {
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
    const text = dictionary(this.options.locale());
    const full = [
      request.title,
      option.label,
      request.detail,
      edited ?? request.plan,
      request.plan ? text.planHint : "",
      option.persistent ? text.persistentHint : ""
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
  const cwd = resolve(values.cwd ?? process.cwd());
  const config = process.env.TERN_CONFIG_DIR ?? (process.platform === "darwin" ? join2(homedir(), "Library", "Application Support", "Tern") : join2(process.env.XDG_STATE_HOME ?? join2(homedir(), ".local", "state"), "tern"));
  const dataDir = resolve(values["data-dir"] ?? join2(config, "plugin-data", "tern-bridge-droid"));
  let preferences = {};
  try {
    const saved = JSON.parse(await readFile2(join2(dataDir, "preferences.json"), "utf8"));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) preferences = saved;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  let locale = values.locale === "en-US" || !values.locale && preferences.locale === "en-US" ? "en-US" : "zh-CN";
  const text = (zh2, en2) => locale === "zh-CN" ? zh2 : en2;
  if (process.env.TERM_PROGRAM?.toLowerCase() !== "tern" || !process.stdin.isTTY) {
    process.stderr.write(text("\u8BF7\u5728 Tern \u7684\u672C\u673A\u7A97\u683C\u4E2D\u6253\u5F00\u6B64\u5BA2\u6237\u7AEF\u3002\n", "Open this client in a local Tern pane.\n"));
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
  let draftRevision = 0;
  let autocompleteCwd = "";
  const notice = new Text2("");
  const identity = new Text2("Droid");
  const composer = new Composer({ preferences: { quiet: true, spellingAutocomplete: "off", spellingTypoDetection: false }, exit: (code) => {
    process.exitCode = code;
    void shutdown();
  } });
  const backend = new DroidBridge({ cwd, dataDir, execPath: values.droid ?? (typeof preferences.droidPath === "string" ? preferences.droidPath : void 0), onChange: changed });
  const transcript = new DroidTranscript(composer.ui, cwd);
  const dialogs = new DroidDialogs(composer, backend, { locale: () => locale, onError: report, onChange: changed, openSession: (id) => open(id) });
  composer.setHeaderExtras([identity], []);
  composer.editor.magicKeywordsEnabledOverride = false;
  composer.editor.onChange = () => {
    draftRevision++;
  };
  composer.editor.composerState = () => ({ running: busy(), thinking: backend.state.session?.settings.reasoningEffort, title: backend.state.session?.title || void 0 });
  composer.editor.composerFacts = {
    describeComposerFacts: () => facts,
    handleNativeEvent(event) {
      if (event.type === "action" && event.act.startsWith("status.")) void perform(() => command(event.act.slice(7)));
    }
  };
  composer.editor.onSubmit = (message) => {
    composer.editor.setText(message);
    void perform(() => submit(message));
  };
  composer.editor.onEscape = () => {
    void perform(() => busy() ? backend.interrupt() : Promise.resolve());
  };
  composer.editor.onClear = () => {
    if (busy()) void perform(() => backend.interrupt());
    else composer.editor.setText("");
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
    { name: "retry", description: "Droid: reconnect without replay" },
    { name: "language", description: "Bridge: \u4E2D\u6587 / English" },
    { name: "help", description: "Bridge: conversation actions" },
    { name: "quit", description: "Bridge: close client" }
  ];
  const nativeChange = onNativeRenderingChange((on) => {
    if (on) composer.ui.terminal.setTitle("Droid");
  });
  function busy() {
    return submitting || backend.state.needsInterrupt || ["connecting", "running", "approval", "question", "stopping"].includes(backend.state.phase);
  }
  function report(error) {
    if (closing) return;
    uiError = error instanceof Error ? error.message : String(error);
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
          void perform(() => open());
        }
      }
    });
  }
  function update() {
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
    const prompt = dialogs.syncPrompts();
    composer.editor.disableSubmit = submitting || ["connecting", "running", "approval", "question", "stopping"].includes(b.phase) || b.needsInterrupt;
    composer.setRuntimeChildren([transcript.container, ...banner ? [banner] : [], ...b.notice ? [notice] : [], prompt ?? composer.editor]);
    if (prompt !== mountedPrompt) {
      mountedPrompt = prompt;
      if (!dialogs.hasOverlay()) composer.ui.setFocus(prompt ?? composer.editor);
    }
    const settings2 = b.session?.settings;
    const selected = b.models.find((model) => model.id === settings2?.modelId);
    const key = JSON.stringify([locale, b.phase, b.context, b.usage, b.session?.title, selected?.label, settings2]);
    if (key !== factsKey) {
      factsKey = key;
      const segments = [
        { key: "sessions", label: t.sessions },
        { key: "more", label: t.more },
        { key: "mode", label: settings2?.interactionMode || t.mode },
        { key: "autonomy", label: settings2?.autonomyLevel || t.autonomy },
        ...["error", "disconnected"].includes(b.phase) ? [{ key: "retry", label: t.reconnect }] : []
      ];
      facts = {
        context: node("meter", {
          role: "omp.composer.context",
          style: "bar",
          value: b.context && b.context.limit > 0 ? Math.min(1, b.context.used / b.context.limit) : null,
          ...b.context ? { label: `${Math.round(b.context.used / b.context.limit * 100)}%`, total: b.context.limit.toLocaleString(locale) } : {},
          title: `${t.context}: ${b.context ? `${b.context.used.toLocaleString(locale)} / ${b.context.limit.toLocaleString(locale)}` : t.unknown}`
        }, void 0, "context"),
        model: { spans: [span(`Droid \xB7 ${selected?.label || settings2?.modelId || t.default}`)], title: t.model },
        extras: node("status", { role: "omp.composer.extras", transparent: true, grow: 1 }, segments.map((item) => node("seg", { spans: [span(item.label)], actions: { click: `status.${item.key}` } }, void 0, item.key)), "extras"),
        usage: node("text", { role: "omp.composer.usage", text: b.usage ? `${b.usage.input.toLocaleString(locale)} ${t.input} \xB7 ${b.usage.output.toLocaleString(locale)} ${t.output}` : "", title: t.usage, wrap: "none" }, void 0, "usage")
      };
    }
    composer.ui.terminal.setTitle(`Droid \xB7 ${b.session?.title || t.untitled}`);
    composer.ui.requestRender();
  }
  async function open(id) {
    pendingNew = null;
    if (busy()) throw new Error(text("\u8BF7\u5148\u505C\u6B62\u5F53\u524D\u4EFB\u52A1\uFF0C\u518D\u5207\u6362\u4F1A\u8BDD\u3002", "Stop the active turn before switching conversations."));
    const previousDraft = composer.editor.getExpandedText();
    composer.editor.setText("");
    const clearedRevision = draftRevision;
    try {
      await backend.open(id);
    } catch (error) {
      if (draftRevision === clearedRevision) composer.editor.setText(previousDraft);
      throw error;
    }
  }
  async function submit(message) {
    if (!message.trim()) return;
    const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(message);
    if (match?.[1] && commands.some((item) => item.name === match[1])) {
      if (composer.editor.getExpandedText() === message) composer.editor.setText("");
      await command(match[1], match[2]);
      return;
    }
    if (busy() || backend.state.phase !== "idle") throw new Error(text("\u5F53\u524D\u65E0\u6CD5\u53D1\u9001\u3002\u8BF7\u5148\u505C\u6B62\u4EFB\u52A1\u6216\u91CD\u65B0\u8FDE\u63A5\u4F1A\u8BDD\u3002", "Cannot send now. Stop the active work or reconnect the session."));
    submitting = true;
    changed();
    try {
      await backend.send(message, () => {
        composer.editor.addToHistory(message);
        if (composer.editor.getExpandedText() === message) composer.editor.setText("");
        changed();
      });
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
      case "resume":
        return argument?.trim() ? open(argument.trim()) : dialogs.sessions();
      case "more":
      case "help": {
        const selected = await dialogs.choose(text("Droid \u4F1A\u8BDD\u64CD\u4F5C", "Droid conversation actions"), commands.filter((item) => item.name !== "help").map((item) => ({ value: item.name, label: `/${item.name}`, description: item.description })));
        if (selected) await command(selected);
        return;
      }
      case "new": {
        if (busy()) {
          if (!await dialogs.confirm(text("\u505C\u6B62\u5E76\u65B0\u5EFA\u5BF9\u8BDD\uFF1F", "Stop and start a new conversation?"), text("\u5DF2\u6267\u884C\u7684\u6587\u4EF6\u4FEE\u6539\u4E0D\u4F1A\u81EA\u52A8\u64A4\u9500\u3002", "File changes already made will not be undone."))) return;
          const source = backend.state.session?.id;
          await backend.interrupt();
          if (source && backend.state.session?.id === source) pendingNew = source;
          changed();
        } else await open();
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
        const value = await dialogs.choose(t.mode, [{ value: "auto", label: "Auto", description: text("\u6267\u884C\u4EFB\u52A1\uFF0C\u4FDD\u7559\u5F53\u524D\u5BA1\u6279\u7B56\u7565\u3002", "Execute with the current approval policy.") }, { value: "spec", label: "Spec", description: text("\u53EA\u8BFB\u5206\u6790\u5E76\u63D0\u51FA\u65B9\u6848\uFF1B\u5207\u6362\u6A21\u5F0F\u4E0D\u4EE3\u8868\u63A5\u53D7\u8BA1\u5212\u3002", "Inspect and propose a plan; switching mode does not accept a plan.") }]);
        if (value) await backend.updateSettings({ interactionMode: value });
        return;
      }
      case "autonomy": {
        const settings2 = backend.state.session?.settings;
        const levels = settings2?.availableAutonomyLevels ?? (settings2?.autonomyLevel ? [settings2.autonomyLevel] : []);
        const value = await dialogs.choose(t.autonomy, levels.map((value2) => ({ value: value2, label: value2 })));
        if (value && (value === "off" || await dialogs.confirm(t.autonomy, text(`Droid \u5C06\u6309 ${value} \u7EA7\u522B\u81EA\u52A8\u6279\u51C6\u4E4B\u540E\u7684\u64CD\u4F5C\u3002`, `Droid will automatically approve subsequent operations allowed by ${value}.`)))) await backend.updateSettings({ autonomyLevel: value });
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
        const value = await dialogs.input(t.compact, argument, text("\u538B\u7F29\u53EF\u80FD\u8C03\u7528\u6A21\u578B\u5E76\u6D88\u8017\u5F53\u524D Droid \u989D\u5EA6\u3002\u53EF\u586B\u5199\u989D\u5916\u8981\u6C42\u3002", "Compaction may call the selected model and use Droid quota. Extra instructions are optional."));
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
        if ((busy() || composer.editor.getText()) && !await dialogs.confirm(text("\u5173\u95ED\u5BA2\u6237\u7AEF\uFF1F", "Close the client?"), text("\u4F1A\u505C\u6B62\u5F53\u524D\u4EFB\u52A1\uFF0C\u672A\u53D1\u9001\u8349\u7A3F\u4E0D\u4F1A\u4FDD\u5B58\uFF1B\u5386\u53F2\u4F1A\u8BDD\u4FDD\u7559\u3002", "The active turn will stop and unsent drafts will be lost. Saved conversations remain."))) return;
        return shutdown();
    }
  }
  async function shutdown() {
    if (closing) return;
    closing = true;
    pendingNew = null;
    dialogs.dispose();
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
