import assert from 'node:assert/strict';
import { extname } from 'node:path';
import test from 'node:test';
import { toolSourceParts } from '../src/tool-source.js';

const languages: Record<string, string> = { '.ts': 'typescript', '.py': 'python' };
const language = (path: string) => languages[extname(path)];
const grep = (output: string, args: object = { output_mode: 'content' }) =>
  toolSourceParts({ name: 'Grep', output, status: 'done' }, args, language);

test('read previews require a real language-bearing file path and never invent a slice line number', () => {
  const source = 'const value = "literal ``` fence";\n';
  assert.deepEqual(toolSourceParts({ name: 'Read', output: source, status: 'running' }, { file_path: '/missing/source.ts', offset: 200 }, language),
    [{ kind: 'read', text: source, lang: 'typescript' }]);
  assert.equal(toolSourceParts({ name: 'Read', output: source, status: 'done' }, { file_path: '/missing/source.unknown' }, language), undefined);
  assert.equal(toolSourceParts({ name: 'Read', output: source, status: 'done' }, {}, language), undefined);
});

test('grep separates file locations from code and preserves match/context lines and language boundaries', () => {
  const parts = grep('src/app.ts:7:const url = "https://host:9000";\nsrc/app.ts-8-// context\nsrc/app.ts:20:return value;\nworker.py:3:print("ok")');
  assert.deepEqual(parts, [
    { kind: 'matches', path: 'src/app.ts', lang: 'typescript', lines: [
      { n: 7, text: 'const url = "https://host:9000";', mark: true },
      { n: 8, text: '// context', mark: false },
      { n: 20, text: 'return value;', mark: true },
    ] },
    { kind: 'matches', path: 'worker.py', lang: 'python', lines: [{ n: 3, text: 'print("ok")', mark: true }] },
  ]);
});

test('grep keeps Windows drives, colon-bearing paths and code containing another filename unambiguous', () => {
  assert.deepEqual(grep('C:\\work\\file.ts:15:const example = "other.py:4:code";\ncache:12:actual.ts:90:export {};\nfolder-2-name.ts-24-// context'), [
    { kind: 'matches', path: 'C:\\work\\file.ts', lang: 'typescript', lines: [{ n: 15, text: 'const example = "other.py:4:code";', mark: true }] },
    { kind: 'matches', path: 'cache:12:actual.ts', lang: 'typescript', lines: [{ n: 90, text: 'export {};', mark: true }] },
    { kind: 'matches', path: 'folder-2-name.ts', lang: 'typescript', lines: [{ n: 24, text: '// context', mark: false }] },
  ]);
});

test('grep preserves unrecognized notices and does not reorder or merge duplicate/backtracking matches', () => {
  const parts = grep('warning: permission denied\na.ts:12:const a = 1;\na.ts:12:const a = 1;\na.ts:3:const earlier = 2;\n--\nb.py:8:print(1)\n[Output truncated]\n');
  assert.deepEqual(parts?.map(part => part.kind === 'matches' ? [part.path, part.lines.map(line => line.n)] : part.kind === 'plain' ? part.lines : part.text), [
    ['warning: permission denied'], ['a.ts', [12]], ['a.ts', [12]], ['a.ts', [3]], ['--'], ['b.py', [8]], ['[Output truncated]', ''],
  ]);
  assert.equal(grep('a.ts:9007199254740992:const value = 1;\na.ts:0:const other = 2;'), undefined);
});

test('single-file grep uses explicit line-number metadata rather than interpreting ordinary numeric code labels', () => {
  assert.deepEqual(grep('12:const a = 1;\n13-// context', { output_mode: 'content', path: '/src/file.ts', line_numbers: true }), [
    { kind: 'matches', path: '/src/file.ts', lang: 'typescript', lines: [{ n: 12, text: 'const a = 1;', mark: true }, { n: 13, text: '// context', mark: false }] },
  ]);
  assert.equal(grep('12:const a = 1;', { output_mode: 'content', path: '/src/file.ts', line_numbers: false }), undefined);
});

test('logs, file lists, count results, errors and unknown output stay in their original renderer', () => {
  const output = 'file.ts:42:const value = 1;';
  for (const name of ['Execute', 'TodoWrite', 'Unknown']) {
    assert.equal(toolSourceParts({ name, output, status: 'done' }, { file_path: 'file.ts', output_mode: 'content' }, language), undefined);
  }
  for (const output_mode of ['files_with_matches', 'count']) assert.equal(grep(output, { output_mode }), undefined);
  assert.equal(grep('No matches found'), undefined);
  assert.equal(toolSourceParts({ name: 'Read', output: 'Permission denied', status: 'error' }, { file_path: 'file.ts' }, language), undefined);
  assert.equal(toolSourceParts({ name: 'Grep', output, status: 'error' }, { output_mode: 'content' }, language), undefined);
});
