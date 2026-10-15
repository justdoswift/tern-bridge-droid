import type { Component, OverlayHandle } from '@oh-my-pi/pi-tui';
import type { Composer } from '@oh-my-pi/pi-tui/prompt/composer';
import { ApprovalDialogComponent } from '@oh-my-pi/pi-tui/overlays/approval-dialog';
import { AskDialogComponent, type ExtensionAskDialogSubmitResult } from '@oh-my-pi/pi-tui/overlays/ask-dialog';
import { HookEditorComponent } from '@oh-my-pi/pi-tui/overlays/hook-editor';
import { HookSelectorComponent } from '@oh-my-pi/pi-tui/overlays/hook-selector';
import { SessionSelectorComponent, type SessionSelectorEntry } from '@oh-my-pi/pi-tui/overlays/session-selector';
import type { DescribeContext, NativeNode } from '@oh-my-pi/pi-tui/native/node';
import type { ApprovalOption, BridgeBackend, Locale, PendingApproval, PendingQuestion, QuestionAnswer, SessionSummary } from './contracts.js';
import { dictionary } from './i18n.js';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import { DroidContextLoading, DroidContextReport, DroidContextView } from './omp-context.js';

export interface DialogChoice {
  value: string;
  label: string;
  description?: string;
  disabledReason?: string;
}

interface DialogOptions {
  locale: () => Locale;
  onError: (error: unknown) => void;
  onChange: () => void;
  openSession: (id: string) => Promise<void>;
}

interface PromptState {
  kind: 'approval' | 'question';
  source: PendingApproval | PendingQuestion;
  sessionId: string | undefined;
  signature: string;
  settled: boolean;
  processing: boolean;
  component?: Component;
}

interface ModalState {
  component: Component;
  handle: OverlayHandle;
  owner?: PromptState;
  sessionId?: string | null;
  cancel: () => void;
}

interface ModalControls<T> {
  finish: (value: T | undefined) => void;
  active: () => boolean;
  replace: (component: Component) => void;
}

/** The stock selector's picker is already a sheet; another overlay leaves an empty modal above it. */
class DroidModalSelector extends HookSelectorComponent {
  nativeSheet(cx: DescribeContext): boolean {
    return cx.supports('picker');
  }
}

/**
 * Keep omp's picker, preview, navigation and events intact. Droid has no session-file
 * size, so the native data projection omits that fact instead of claiming zero bytes.
 * The supported host is Tern's native picker, not the upstream ANSI fallback.
 */
class DroidSessionSelector extends SessionSelectorComponent {
  missingDates: ReadonlySet<string> = new Set();
  loadingMessage?: string;
  private readonly descriptions = new WeakMap<NativeNode, NativeNode>();

  override describe(cx: DescribeContext): NativeNode {
    const original = super.describe(cx);
    if (original.k !== 'picker' || !original.p) return original;
    const cached = this.descriptions.get(original);
    if (cached) return cached;
    const props = original.p;
    const projectItems = (items: NonNullable<typeof props.items>): typeof items => items.map(item => {
      const facts = { ...item.facts };
      delete facts.size;
      const projected = { ...item, facts };
      if (this.missingDates.has(item.id)) {
        delete facts.when;
        delete projected.title;
      }
      return projected;
    });
    const children = original.c?.map(child => {
      if (!('k' in child) || child.k !== 'kv' || !child.p) return child;
      return { ...child, p: { ...child.p, items: child.p.items.filter(fact => {
        const label = typeof fact.k === 'string' ? fact.k : fact.k.map(part => part.t).join('');
        if (label === 'Size') return false;
        return label !== 'Modified' || !this.missingDates.has(props.selected ?? '');
      }) } };
    });
    const projected: NativeNode = {
      ...original,
      p: {
        ...props,
        columns: props.columns?.filter(column => column.id !== 'size'),
        ...(props.items ? { items: projectItems(props.items) } : {}),
        ...(props.itemsAdd ? { itemsAdd: projectItems(props.itemsAdd) } : {}),
        // An absent date must not silently claim the upstream "Earlier" day group.
        ...(props.order?.some(item => typeof item === 'string' && this.missingDates.has(item))
          ? { order: props.order.filter((item): item is string => typeof item === 'string') } : {}),
        ...(this.loadingMessage ? { state: 'loading', message: this.loadingMessage } : {}),
      },
      c: children,
    };
    this.descriptions.set(original, projected);
    return projected;
  }
}

/** Request lifetime/focus adapter; all presentation and input belong to omp components. */
export class DroidDialogs {
  private modal?: ModalState;
  private prompt?: PromptState;
  private disposed = false;

  constructor(
    private readonly composer: Composer,
    private readonly backend: BridgeBackend,
    private readonly options: DialogOptions,
  ) {}

  async sessions(): Promise<void> {
    this.syncPrompts();
    await this.showModal<void>(controls => {
      const text = dictionary(this.options.locale());
      let generation = 0;
      let opening = false;
      const missingDates = new Set<string>();
      const close = () => controls.finish(undefined);
      const entries = (items: SessionSummary[]): SessionSelectorEntry[] => items.map(item => {
        const parsed = new Date(item.modifiedTime ?? Number.NaN);
        const missingDate = Number.isNaN(parsed.getTime());
        if (missingDate) missingDates.add(item.id);
        else missingDates.delete(item.id);
        return {
          // This is an opaque Droid identity, never a session file to read or delete.
          path: item.id,
          id: item.id,
          cwd: item.cwd ?? '',
          title: item.title,
          // Private API placeholders only: describe() removes every corresponding
          // fact, preview and date group before Tern sees the original picker.
          modified: missingDate ? new Date(0) : parsed,
          size: 0,
          firstMessage: '',
          allMessagesText: '',
        };
      });
      const picker = (items: SessionSelectorEntry[], loading = false): SessionSelectorComponent => {
        const component = new DroidSessionSelector(items, session => {
          if (!controls.active() || opening || loading) return;
          opening = true;
          component.lockInput();
          void this.options.openSession(session.id).then(() => {
            if (controls.active()) close();
          }).catch(error => {
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
          ...(loading ? {} : {
            loadAllSessions: async () => {
              try {
                const all = await this.backend.sessions(true);
                if (!controls.active()) throw new Error('Session selector was closed.');
                return entries(all);
              } catch (error) {
                if (controls.active()) this.options.onError(error);
                throw error;
              }
            },
          }),
        });
        component.missingDates = missingDates;
        component.loadingMessage = loading ? text.loading : undefined;
        // No delete callback, confirmation, DB matcher, or filesystem behavior.
        component.getSessionList().onDeleteRequest = undefined;
        component.setOnRequestRender(() => {
          if (controls.active()) this.options.onChange();
        });
        return component;
      };
      const load = async (): Promise<void> => {
        const current = ++generation;
        try {
          const items = await this.backend.sessions(false);
          if (controls.active() && current === generation) controls.replace(picker(entries(items)));
        } catch (error) {
          if (!controls.active() || current !== generation) return;
          this.options.onError(error);
          const retry = this.options.locale() === 'zh-CN' ? '重试' : 'Retry';
          controls.replace(new DroidModalSelector(
            `${text.sessions}\n${error instanceof Error ? error.message : String(error)}`,
            [retry, text.cancel],
            selected => {
              if (!controls.active()) return;
              if (selected !== retry) { close(); return; }
              controls.replace(picker([], true));
              void load();
            }, close, { tui: this.composer.ui },
          ));
        }
      };
      // Mount the real selector before starting asynchronous backend discovery.
      queueMicrotask(() => { if (controls.active()) void load(); });
      return picker([], true);
    });
  }

  async context(): Promise<void> {
    this.syncPrompts();
    const sessionId = this.backend.state.session?.id ?? null;
    await this.showModal<void>(controls => {
      const locale = this.options.locale();
      const t = dictionary(locale);
      const close = () => controls.finish(undefined);
      const loading = () => new DroidContextReport(t.context, new DroidContextLoading(locale), locale, close);
      let pending = false;
      const load = async (): Promise<void> => {
        if (!controls.active() || pending) return;
        pending = true;
        try {
          const details = await this.backend.contextDetails();
          if (controls.active()) controls.replace(new DroidContextReport(
            `${t.context} · ${details.modelDisplayName || details.modelId}`, new DroidContextView(details, locale), locale, close,
          ));
        } catch {
          if (controls.active()) controls.replace(new DroidContextReport(
            t.context, new Text(t.contextFailed, 0, 0), locale, close,
            () => {
              if (!controls.active() || pending) return;
              controls.replace(loading());
              void load();
            },
          ));
        } finally { pending = false; }
      };
      queueMicrotask(() => { if (controls.active()) void load(); });
      return loading();
    }, undefined, sessionId);
  }

  async choose(title: string, choices: DialogChoice[]): Promise<string | undefined> {
    this.syncPrompts();
    const offered = choices.map(choice => ({ ...choice }));
    return this.showModal<string>(controls => {
      const rows = this.choiceRows(offered);
      return new DroidModalSelector(title, rows, label => {
        if (!controls.active()) return;
        const index = rows.findIndex(row => row.label === label);
        const choice = offered[index];
        if (choice && !choice.disabledReason) controls.finish(choice.value);
      }, () => controls.finish(undefined), {
        tui: this.composer.ui,
        disabledIndices: offered.flatMap((choice, index) => choice.disabledReason ? [index] : []),
      });
    });
  }

  input(title: string, initial?: string, detail?: string): Promise<string | undefined> {
    this.syncPrompts();
    return this.edit(title, initial, detail);
  }

  async confirm(title: string, detail: string): Promise<boolean> {
    this.syncPrompts();
    return (await this.showModal<boolean>(controls => new ApprovalDialogComponent(
      `${title}\n${detail}`, {
        onApprove: () => { if (controls.active()) controls.finish(true); },
        onDeny: () => controls.finish(false),
      }, { tui: this.composer.ui, fullPrompt: `${title}\n${detail}` },
    ))) === true;
  }

  syncPrompts(): Component | undefined {
    if (this.disposed) return undefined;
    const live = this.livePrompt();
    const sessionId = this.backend.state.session?.id;
    if (this.modal?.sessionId !== undefined && this.modal.sessionId !== (sessionId ?? null)) this.modal.cancel();
    const signature = live ? JSON.stringify(live.source) : '';
    if (this.prompt && (!live || this.prompt.kind !== live.kind || this.prompt.source !== live.source ||
        this.prompt.sessionId !== sessionId || this.prompt.signature !== signature)) {
      const old = this.prompt;
      this.prompt = undefined;
      old.settled = true;
      if (this.modal?.owner === old) this.modal.cancel();
      old.component?.dispose?.();
    }
    if (!live) return undefined;
    // Once a backend prompt arrives, ordinary selectors cannot remain hidden or own focus.
    if (this.modal && !this.modal.owner) this.modal.cancel();
    if (!this.prompt) {
      const prompt: PromptState = {
        ...live, sessionId, signature, settled: false, processing: false,
      };
      this.prompt = prompt;
      if (prompt.kind === 'approval') this.approvalChoices(prompt);
      else this.questions(prompt);
    }
    return this.prompt.component;
  }

  hasOverlay(): boolean {
    return !!this.modal && !this.modal.handle.isHidden() && this.modalCurrent(this.modal);
  }

  cancelOverlay(): boolean {
    this.syncPrompts();
    if (!this.hasOverlay()) return false;
    this.modal!.cancel();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const prompt = this.prompt;
    this.prompt = undefined;
    if (prompt) prompt.settled = true;
    this.modal?.cancel();
    prompt?.component?.dispose?.();
  }

  private livePrompt(): Pick<PromptState, 'kind' | 'source'> | undefined {
    const state = this.backend.state;
    // Stop must invalidate actions even while the backend still displays its previous request.
    if (state.phase === 'approval' && state.approval) return { kind: 'approval', source: state.approval };
    if (state.phase === 'question' && state.question) return { kind: 'question', source: state.question };
    return undefined;
  }

  private current(prompt: PromptState): boolean {
    const live = this.livePrompt();
    return !this.disposed && this.prompt === prompt && !prompt.settled &&
      this.backend.state.session?.id === prompt.sessionId && live?.kind === prompt.kind &&
      live.source === prompt.source && JSON.stringify(live.source) === prompt.signature;
  }

  private modalCurrent(modal: ModalState): boolean {
    return !this.disposed && this.modal === modal &&
      (modal.sessionId === undefined || modal.sessionId === (this.backend.state.session?.id ?? null)) &&
      (modal.owner ? this.current(modal.owner) : !this.livePrompt());
  }

  private focus(): void {
    if (this.disposed || this.modal) return;
    this.composer.ui.setFocus(this.prompt?.component ?? this.composer.editor);
  }

  private showModal<T>(create: (controls: ModalControls<T>) => Component, owner?: PromptState, sessionId?: string | null): Promise<T | undefined> {
    if (this.disposed || (owner ? !this.current(owner) : !!this.livePrompt())) return Promise.resolve(undefined);
    this.modal?.cancel();
    const { promise, resolve } = Promise.withResolvers<T | undefined>();
    let modal: ModalState;
    let closed = false;
    const finish = (value: T | undefined): void => {
      if (closed) return;
      closed = true;
      const valid = this.modalCurrent(modal);
      if (this.modal === modal) this.modal = undefined;
      modal.handle.hide();
      modal.component.dispose?.();
      this.focus();
      resolve(valid ? value : undefined);
      if (!this.disposed) this.options.onChange();
    };
    const component = create({
      finish,
      active: () => !closed && this.modalCurrent(modal),
      replace: replacement => {
        if (closed || !this.modalCurrent(modal)) { replacement.dispose?.(); return; }
        modal.handle.hide();
        modal.component.dispose?.();
        modal.component = replacement;
        modal.handle = this.composer.ui.showOverlay(replacement, { width: '90%', maxHeight: '90%' });
        this.options.onChange();
      },
    });
    modal = {
      component, owner, sessionId, cancel: () => finish(undefined),
      handle: this.composer.ui.showOverlay(component, { width: '90%', maxHeight: '90%' }),
    };
    this.modal = modal;
    this.options.onChange();
    return promise;
  }

  private edit(title: string, initial?: string, detail?: string, owner?: PromptState, promptStyle = false): Promise<string | undefined> {
    return this.showModal<string>(controls => new HookEditorComponent(
      this.composer.ui, title, initial,
      value => { if (controls.active()) controls.finish(value); },
      () => controls.finish(undefined),
      { question: detail, promptStyle },
    ), owner);
  }

  private choiceRows(choices: DialogChoice[]): { label: string; description?: string }[] {
    // HookSelector returns labels, not indices. Make duplicate labels unambiguous without changing values.
    const used = new Set<string>();
    return choices.map(choice => {
      let label = choice.label;
      let suffix = 2;
      while (used.has(label)) label = `${choice.label} [${suffix++}]`;
      used.add(label);
      const description = [choice.description, choice.disabledReason].filter(Boolean).join('\n');
      return { label, ...(description ? { description } : {}) };
    });
  }

  private replacePrompt(prompt: PromptState, component: Component): void {
    if (!this.current(prompt)) { component.dispose?.(); return; }
    const previous = prompt.component;
    prompt.component = component;
    previous?.dispose?.();
    this.focus();
  }

  private approvalChoices(prompt: PromptState): void {
    if (!this.current(prompt)) return;
    const request = prompt.source as PendingApproval;
    const text = dictionary(this.options.locale());
    const offered = request.options.map(option => ({ ...option }));
    const choices = offered.map(option => ({
      value: option.value,
      label: option.label,
      description: option.persistent ? text.persistentHint : undefined,
      disabledReason: option.disabledReason ?? (option.value.startsWith('proceed_new_session')
        ? 'Droid SDK cannot identify a new implementation session. Use an offered current-session outcome.' : undefined),
    }));
    const rows = this.choiceRows(choices);
    prompt.processing = false;
    const selector = new HookSelectorComponent(
      [request.title, request.detail, request.plan, offered.some(option => option.persistent) ? text.persistentHint : '',
        offered.length ? '' : text.noPermissions].filter(Boolean).join('\n\n'),
      rows,
      label => {
        if (!this.current(prompt) || prompt.component !== selector || prompt.processing) return;
        const index = rows.findIndex(row => row.label === label);
        const option = offered[index];
        if (!option || choices[index]?.disabledReason) return;
        prompt.processing = true;
        if (option.value === 'cancel') { this.settleApproval(prompt, option); return; }
        if (option.value === 'proceed_edit') {
          void this.edit(text.editPlanHint, request.plan ?? '', request.detail, prompt).then(content => {
            if (!this.current(prompt)) return;
            if (content === undefined) { this.approvalChoices(prompt); this.options.onChange(); return; }
            if (!content.trim()) {
              this.options.onError(new Error(this.options.locale() === 'zh-CN' ? '修改后的计划不能为空。' : 'The edited plan cannot be empty.'));
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
        const cancel = offered.find(option => option.value === 'cancel' && !option.disabledReason);
        if (cancel) this.settleApproval(prompt, cancel);
        else void this.backend.interrupt().catch(error => this.options.onError(error));
      },
      { tui: this.composer.ui, inline: true,
        disabledIndices: choices.flatMap((choice, index) => choice.disabledReason ? [index] : []) },
    );
    this.replacePrompt(prompt, selector);
  }

  private approvalConfirmation(prompt: PromptState, option: ApprovalOption, edited?: string): void {
    const request = prompt.source as PendingApproval;
    const text = dictionary(this.options.locale());
    const full = [request.title, option.label, request.detail, edited ?? request.plan,
      request.plan ? text.planHint : '', option.persistent ? text.persistentHint : ''].filter(Boolean).join('\n\n');
    const confirmation = new ApprovalDialogComponent(full, {
      onApprove: () => {
        if (prompt.component === confirmation) this.settleApproval(prompt, option, edited);
      },
      onDeny: () => {
        if (!this.current(prompt) || prompt.component !== confirmation) return;
        this.approvalChoices(prompt);
        this.options.onChange();
      },
    }, { tui: this.composer.ui, fullPrompt: full });
    // ApprovalDialog owns its arming delay and deliberate approve chord; plain Enter never grants.
    this.replacePrompt(prompt, confirmation);
  }

  private settleApproval(prompt: PromptState, option: ApprovalOption, edited?: string): void {
    if (!this.current(prompt)) return;
    const request = prompt.source as PendingApproval;
    if (!request.options.some(offered => offered.value === option.value && !offered.disabledReason) ||
        option.value.startsWith('proceed_new_session') || (option.value === 'proceed_edit' && !edited?.trim())) return;
    prompt.settled = true;
    try { this.backend.resolveApproval(request.id, option.value, edited); }
    catch (error) { this.options.onError(error); }
    this.options.onChange();
  }

  private questions(prompt: PromptState, collected = new Map<string, QuestionAnswer>()): void {
    if (!this.current(prompt)) return;
    const request = prompt.source as PendingQuestion;
    const remaining = request.questions.flatMap((question, position) => {
      const id = String(position);
      return collected.has(id) ? [] : [{
        id, question: question.question, header: question.topic,
        options: question.options.map(label => ({ label })), multi: question.multiSelect,
      }];
    });
    const dialog = new AskDialogComponent(remaining, {
      onSubmit: result => {
        if (!this.current(prompt) || prompt.component !== dialog) return;
        this.collectAnswers(request, result, collected);
        if (collected.size !== request.questions.length) {
          this.options.onError(new Error(this.options.locale() === 'zh-CN'
            ? '请回答剩余问题，或取消整个问卷。' : 'Answer the remaining questions, or cancel the questionnaire.'));
          // Ask permits skipping. Keep every completed answer and ask only the unanswered subset.
          this.questions(prompt, collected);
          this.options.onChange();
          return;
        }
        prompt.settled = true;
        try { this.backend.resolveQuestion(request.id, request.questions.map((_, position) => collected.get(String(position))!)); }
        catch (error) { this.options.onError(error); }
        this.options.onChange();
      },
      onCancel: () => {
        if (!this.current(prompt) || prompt.component !== dialog) return;
        prompt.settled = true;
        try { this.backend.resolveQuestion(request.id, null); }
        catch (error) { this.options.onError(error); }
        this.options.onChange();
      },
      onPrompt: (question, prefill) => {
        if (!this.current(prompt) || prompt.component !== dialog) return Promise.resolve(undefined);
        return this.edit(question.title, prefill, question.question, prompt, true);
      },
    }, { tui: this.composer.ui });
    this.replacePrompt(prompt, dialog);
  }

  private collectAnswers(request: PendingQuestion, result: ExtensionAskDialogSubmitResult, collected: Map<string, QuestionAnswer>): void {
    for (const response of result.results) {
      const position = Number(response.id);
      const question = request.questions[position];
      if (!question || String(position) !== response.id || response.question !== question.question) continue;
      const selected = response.selectedOptions.filter(option => question.options.includes(option));
      const parts = [...selected];
      if (response.customInput?.trim()) parts.push(response.customInput);
      if (!parts.length) continue;
      if (response.note?.trim()) parts.push(response.note);
      collected.set(response.id, { index: question.index, question: question.question, answer: parts.join('\n') });
    }
  }
}
