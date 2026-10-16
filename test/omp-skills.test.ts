import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Exercise the published omp component in its supported Bun runtime. All skills,
// paths and messages here are synthetic; no installed skill or Droid process is read.
test('canonical Droid skills fold with original omp cards in live and restored history', () => {
  const result = spawnSync('bun', ['--eval', String.raw`
    import assert from 'node:assert/strict';
    import { SkillMessageComponent } from '@oh-my-pi/pi-tui/chat/skill-message';
    import { UserMessageComponent } from '@oh-my-pi/pi-tui/chat/user-message';
    import { ensureThemeSync } from '@oh-my-pi/pi-tui/theme';
    import { droidSkillPresentations, skillMessage } from './src/omp-skills.ts';
    import { DroidTranscript } from './src/omp-transcript.ts';
    import { Transcript } from './src/transcript.ts';

    ensureThemeSync();
    const wrapper = (name = 'fixture-review', body = 'SYNTHETIC_SKILL_BODY\nSecond line') => [
      '<system-notification>',
      'Skills provide specialized capabilities and domain knowledge. The user has selected the following skill for immediate execution by typing /' + name + " in their message; that token invokes the skill and is not a path or part of the request. Begin following the skill's instructions now.",
      '<skill filePath="/fixture/review&amp;notes/SKILL.md">',
      '<name>' + name + '</name>',
      '<description>Synthetic review (project)</description>',
      body, '</skill>', '</system-notification>',
    ].join('\n');
    const raw = '/fixture-review inspect  exact arguments\n\n' + wrapper();
    const presentation = droidSkillPresentations(raw);
    assert.equal(presentation.length, 1);
    assert.equal(presentation[0].name, 'fixture-review');
    assert.equal(presentation[0].args, 'inspect  exact arguments');
    assert.equal(presentation[0].path, '/fixture/review&notes/SKILL.md');
    assert.equal(presentation[0].content, raw);
    const card = skillMessage(presentation[0]);
    assert.ok(card instanceof SkillMessageComponent);
    let view = JSON.stringify(card.describe());
    assert.ok(view.includes('fixture-review'));
    assert.ok(view.includes('inspect  exact arguments'));
    assert.equal(view.includes('SYNTHETIC_SKILL_BODY'), false);
    assert.ok(view.includes('"collapsed":true'));
    assert.deepEqual(card.describe().p.preview, { lines: 3 }, 'collapsed native cards must retain the user argument preview');
    assert.equal(card.describe(), card.describe(), 'preview projections remain stable between renders');
    card.handleNativeEvent({ type: 'toggle', key: '', collapsed: false });
    view = JSON.stringify(card.describe());
    assert.ok(view.includes('SYNTHETIC_SKILL_BODY'));
    assert.ok(view.includes(JSON.stringify(raw).slice(1, -1)), 'expanded card retains the entire original payload');
    card.handleNativeEvent({ type: 'toggle', key: '', collapsed: true });
    assert.equal(JSON.stringify(card.describe()).includes('SYNTHETIC_SKILL_BODY'), false);
    card.dispose();
    const noArgs = skillMessage(droidSkillPresentations(wrapper())[0]);
    assert.equal(noArgs.describe().p.preview, undefined, 'empty invocations do not preview hidden instructions');
    assert.equal(JSON.stringify(noArgs.describe()).includes('SYNTHETIC_SKILL_BODY'), false);
    noArgs.dispose();

    const direct = wrapper() + '\n\nlegacy argument';
    assert.equal(droidSkillPresentations(direct)[0].args, 'legacy argument');
    assert.equal(droidSkillPresentations(direct)[0].content, direct);
    const inline = 'Compare /fixture-review, then /second-skill please\n\n' + wrapper() + '\n\n' + wrapper('second-skill', 'SECOND_SYNTHETIC_BODY');
    const multiple = droidSkillPresentations(inline);
    assert.deepEqual(multiple.map(skill => skill.name), ['fixture-review', 'second-skill']);
    assert.equal(multiple[0].args, 'Compare /fixture-review, then /second-skill please');
    assert.equal(multiple[0].content, inline);

    const fence = String.fromCharCode(96).repeat(3);
    const ordinary = [
      'Ordinary prose mentioning /fixture-review',
      '<skill name="fixture-review">not a Droid invocation</skill>',
      'An example follows:\n\n' + wrapper(),
      fence + '\n/fixture-review\n\n' + wrapper() + '\n' + fence,
      raw.replace('</system-notification>', ''),
      raw.replace('<name>fixture-review</name>', '<name>other</name>'),
      raw.replace('<skill filePath=', '<skill path='),
      raw.replace('\n</skill>\n', '\n</wrong>\n'),
      raw + '\nextra unmatched text',
    ];
    for (const text of ordinary) assert.equal(droidSkillPresentations(text), undefined, text);

    const ui = { requestRender() {}, requestComponentRender() {}, imageBudget: { release() {} } };
    const base = () => ({
      phase: 'idle', needsInterrupt: false, workingState: null,
      session: { id: 'fixture-session', title: '', cwd: '/fixture', settings: { modelId: '', reasoningEffort: '', autonomyLevel: '', interactionMode: '' } },
      messages: [], models: [], approval: null, question: null, error: null, notice: null, context: null, usage: null,
    });
    for (const restored of [false, true]) {
      const authoritative = new Transcript();
      const message = { id: 'fixture-user', role: 'user', content: [{ type: 'text', text: raw }] };
      if (restored) authoritative.hydrate([message]);
      else authoritative.apply({ type: 'create_message', message });
      const state = base(); state.messages = authoritative.messages;
      const before = JSON.stringify(state.messages);
      const transcript = new DroidTranscript(ui, '/fixture');
      transcript.sync(state);
      const component = transcript.container.children[0].children[0].children[0];
      assert.ok(component instanceof SkillMessageComponent);
      assert.equal(JSON.stringify(component.describe()).includes('SYNTHETIC_SKILL_BODY'), false);
      component.handleNativeEvent({ type: 'toggle', key: '', collapsed: false });
      transcript.sync(state);
      assert.equal(transcript.container.children[0].children[0].children[0], component);
      assert.ok(JSON.stringify(component.describe()).includes('SYNTHETIC_SKILL_BODY'));
      transcript.setExpanded(false);
      assert.equal(JSON.stringify(component.describe()).includes('SYNTHETIC_SKILL_BODY'), false);
      assert.equal(JSON.stringify(state.messages), before, 'presentation must never rewrite backend history');
      transcript.dispose();
    }
    for (const text of ordinary) {
      const state = base(); state.messages = [{ id: 'plain', role: 'user', blocks: [{ id: 'plain:0', kind: 'text', text }] }];
      const transcript = new DroidTranscript(ui, '/fixture'); transcript.sync(state);
      assert.ok(transcript.container.children[0].children[0].children[0] instanceof UserMessageComponent);
      transcript.dispose();
    }
    const state = base();
    state.messages = [{ id: 'partial', role: 'user', streaming: true, blocks: [{ id: 'partial:0', kind: 'text', text: raw.slice(0, -10) }] }];
    const live = new DroidTranscript(ui, '/fixture'); live.sync(state);
    assert.ok(live.container.children[0].children[0].children[0] instanceof UserMessageComponent);
    state.messages[0].blocks[0].text = raw; live.sync(state);
    assert.ok(live.container.children[0].children[0].children[0] instanceof SkillMessageComponent);
    live.dispose();
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
