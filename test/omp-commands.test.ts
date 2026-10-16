import assert from 'node:assert/strict';
import test from 'node:test';
import { commandEntries, discoveredCommands, routeCommand, type CommandCatalog } from '../src/omp-commands.js';

const skill = (name: string, fields: object = {}) => ({ name, description: 'Synthetic skill', location: 'project', filePath: `/fixture/${name}/SKILL.md`, content: 'Synthetic body never retained in menus', ...fields });
const ready = (entries = discoveredCommands({ commands: [] }, { skills: [] })): CommandCatalog => ({ status: 'ready', entries, error: null });

test('SDK discovery keeps supported custom commands and effective invocable skills, without retaining bodies', () => {
  const entries = discoveredCommands({ commands: [{ name: 'release', description: 'Release shortcut', argumentHint: '<version>', isExecutable: true }] }, {
    skills: [skill('review'), skill('disabled', { enabled: false }), skill('private-helper', { userInvocable: false }),
      skill('ledger-disabled', { disabledBy: { kind: 'frontmatter' } }), skill('release'), skill('invalid-empty', { content: '' }), skill('---'), skill('invalid_name')],
  });
  assert.deepEqual(entries, [
    { name: 'release', description: 'Release shortcut', kind: 'command', argumentHint: '<version>' },
    { name: 'review', description: 'Synthetic skill', kind: 'skill' },
  ]);
  assert.equal(JSON.stringify(entries).includes('Synthetic body'), false);
  const menu = commandEntries('en-US', ready(entries));
  assert.ok(menu.find(item => item.name === 'release')?.description.includes('<version>'));
  assert.ok(menu.find(item => item.name === 'review')?.description.includes('Skill'));
  for (const cliOnly of ['login', 'logout', 'skills', 'mcp', 'plugins', 'diagnostics']) assert.equal(menu.some(item => item.name === cliOnly), false);
});

test('remote names win local aliases and custom commands win same-name skills case-insensitively', () => {
  const catalog = ready(discoveredCommands({ commands: [{ name: 'Model', description: 'Custom model command' }] }, { skills: [skill('model'), skill('new')] }));
  assert.equal(routeCommand('/Model args', catalog).kind, 'remote');
  assert.equal(routeCommand('/new args', catalog).kind, 'remote');
  assert.deepEqual(routeCommand('/bridge:model', catalog), { kind: 'local', name: 'model', argument: undefined });
  assert.deepEqual(routeCommand('/bridge:rename New name', catalog), { kind: 'local', name: 'rename', argument: 'New name' });
  assert.equal(commandEntries('en-US', catalog).filter(item => item.name.toLowerCase() === 'model').length, 1);
  assert.ok(commandEntries('en-US', catalog).some(item => item.name === 'bridge:new'));
});

test('unknown slash intent is rejected rather than converted to prose, including unsupported CLI actions', () => {
  for (const source of ['/skills', '/diagnostics', '/missing with arguments', '  /missing', '/']) assert.equal(routeCommand(source, ready()).kind, 'unknown');
  for (const source of ['ordinary prose', 'code example: /review', 'please use /review here', '```\n/review\n```']) assert.equal(routeCommand(source, ready()).kind, 'message');
});

test('loading or failed discovery offers only explicit bridge actions and never guesses colliding aliases', () => {
  for (const status of ['loading', 'error'] as const) {
    const catalog: CommandCatalog = { status, entries: [{ name: 'old-skill', kind: 'skill', description: 'Stale' }], error: 'Discovery unavailable' };
    assert.ok(commandEntries('en-US', catalog).every(item => item.name.startsWith('bridge:')));
    assert.equal(routeCommand('/old-skill', catalog).kind, 'unavailable');
    assert.equal(routeCommand('/new', catalog).kind, 'unavailable');
    assert.equal(routeCommand('/bridge:retry', catalog).kind, 'local');
    assert.equal(routeCommand('/bridge:commands', catalog).kind, 'local');
  }
  assert.throws(() => discoveredCommands({ commands: 'invalid' }, { skills: [] }));
  assert.throws(() => discoveredCommands({ commands: [] }, { skills: [{ name: 'missing-path' }] }));
});

test('menus recompute descriptions for locale and entries for each authoritative catalog', () => {
  const catalog = ready(discoveredCommands({ commands: [] }, { skills: [skill('first')] }));
  assert.match(commandEntries('zh-CN', catalog).find(item => item.name === 'first')!.description, /^技能/);
  assert.match(commandEntries('en-US', catalog).find(item => item.name === 'first')!.description, /^Skill/);
  assert.notEqual(commandEntries('zh-CN', catalog).find(item => item.name === 'bridge:model')!.description,
    commandEntries('en-US', catalog).find(item => item.name === 'bridge:model')!.description);
  const next = ready(discoveredCommands({ commands: [] }, { skills: [skill('second')] }));
  assert.equal(commandEntries('en-US', next).some(item => item.name === 'first'), false);
  assert.equal(routeCommand('/second', next).kind, 'remote');
});
