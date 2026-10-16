import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const hasZsh = spawnSync('zsh', ['--version']).status === 0;

test('zsh accepts every Droid casing without changing arguments, exit codes or existing commands', { skip: !hasZsh }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droid-launcher-'));
  const env = { HOME: dir, ZDOTDIR: dir, PATH: `${dir}:/usr/bin:/bin`,
    TERN_DROID_BRIDGE_DIR: root, TERN_DROID_BRIDGE_DROID: join(dir, 'droid'),
    TERN_DROID_BRIDGE_ZDOTDIR_SET: '1', TERN_DROID_BRIDGE_ZDOTDIR: dir };
  const run = async (body: string) => {
    await writeFile(join(dir, 'actions.zsh'), body);
    return spawnSync('zsh', ['-dfi', '-c',
      'source "$TERN_DROID_BRIDGE_DIR/shell/zsh/.zshenv"\n_tern_droid_bridge_ready\nsource "$HOME/actions.zsh"'],
      { env, cwd: dir, encoding: 'utf8', timeout: 10_000 });
  };
  try {
    await writeFile(join(dir, 'droid'), '#!/bin/sh\nprintf "arg:<%s>\\n" "$@"\nexit 23\n', { mode: 0o700 });
    const variants = [...'droid'].reduce((names, letter) => names.flatMap(name => [name + letter, name + letter.toUpperCase()]), ['']);
    const result = await run('for name in {d,D}{r,R}{o,O}{i,I}{d,D}; do\nprint -r -- "$name"\n"$name" "two words" --version\nprintf "exit:%s\\n" $?\ndone');
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, variants.map(name => `${name}\narg:<two words>\narg:<--version>\nexit:23\n`).join(''));

    await writeFile(join(dir, '.zshenv'), 'alias Droid="print -r -- kept-alias"\nDROID() { print -r -- kept-function; }\n');
    await mkdir(join(dir, 'custom'));
    await writeFile(join(dir, 'custom', 'dRoId'), '#!/bin/sh\nprintf "kept-executable\\n"\n', { mode: 0o700 });
    env.PATH = `${dir}/custom:${dir}:/usr/bin:/bin`;
    const preserved = await run('Droid\nDROID\ndRoId\ncommand droid official\nprintf "exit:%s\\n" $?\nprint -r -- "$ZDOTDIR"');
    assert.ifError(preserved.error);
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.equal(preserved.stdout, `kept-alias\nkept-function\nkept-executable\narg:<official>\nexit:23\n${dir}\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
