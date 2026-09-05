import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadReleases, parseRelease, promoteUnreleased, renderAppChangelog, renderIndex, renderVsCodeChangelog } from './lib.mjs';

const banner = '<!-- Generated from changelog/*.md by `bun run changelog:build`. Edit those files, not this one. -->';

const release = `---
version: 1.2.3
date: 2026-01-31
title: Comments everywhere
---

A short intro.

## App

### Fixes
- Chat: huge patches open without freezing the page (thanks to @someone).

### New
- **Comments:** select text and comment on it.

## VS Code

### New
- Comments on code.
`;

test('parses front matter, intro, sections, and groups', () => {
  const parsed = parseRelease(release, 'changelog/1.2.3.md');
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.date, '2026-01-31');
  assert.equal(parsed.title, 'Comments everywhere');
  assert.deepEqual(parsed.intro, ['A short intro.']);
  assert.deepEqual(parsed.app, {
    Fixes: ['Chat: huge patches open without freezing the page (thanks to @someone).'],
    New: ['**Comments:** select text and comment on it.'],
  });
  assert.deepEqual(parsed.vscode, { New: ['Comments on code.'] });
});

test('rejects shapes the generator cannot render', () => {
  assert.throws(() => parseRelease('## App\n### Nope\n- x\n', 'f.md'), /unknown group "Nope"/);
  assert.throws(() => parseRelease('## Desktop\n', 'f.md'), /unknown section "Desktop"/);
  assert.throws(() => parseRelease('- orphan\n', 'f.md'), /must sit under a ### group/);
  assert.throws(() => parseRelease('## App\n### New\nstray text\n', 'f.md'), /unexpected text inside a section/);
  assert.throws(() => parseRelease('---\nversion: 1.2\ndate: 2026-01-31\n---\n', 'f.md'), /is not x\.y\.z/);
});

test('renders groups in canonical order with today\'s headers and skips versions without a VS Code section', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  fs.writeFileSync(path.join(directory, '1.2.3.md'), release);
  fs.writeFileSync(path.join(directory, '1.2.4.md'), '---\nversion: 1.2.4\ndate: 2026-02-01\n---\n\n## App\n\n### Improvements\n- Faster.\n');
  fs.writeFileSync(path.join(directory, 'unreleased.md'), '## App\n\n### Fixes\n- Pending fix.\n\n## VS Code\n');
  const loaded = loadReleases(directory);

  assert.equal(renderAppChangelog(loaded), `# Changelog

${banner}

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixes

- Pending fix.

## [1.2.4] - 2026-02-01

### Improvements

- Faster.

## [1.2.3] - 2026-01-31

A short intro.

### New

- **Comments:** select text and comment on it.

### Fixes

- Chat: huge patches open without freezing the page (thanks to @someone).
`);

  assert.equal(renderVsCodeChangelog(loaded), `${banner}

## [Unreleased]

## [1.2.3] - 2026-01-31

### New

- Comments on code.
`);

  const index = JSON.parse(renderIndex(loaded));
  assert.equal(index.length, 2);
  assert.equal(index[0].version, '1.2.4');
  assert.equal(index[1].title, 'Comments everywhere');
  assert.deepEqual(index[1].vscode, { new: ['Comments on code.'], improvements: [], fixes: [], misc: [] });
  assert.equal(index[0].vscode, null);
});

test('loadReleases refuses a file whose name and version disagree', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  fs.writeFileSync(path.join(directory, '9.9.9.md'), release);
  assert.throws(() => loadReleases(directory), /does not match the file name 9\.9\.9/);
});

test('promoteUnreleased dates the release, resets the template, and refuses an empty release', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  fs.writeFileSync(path.join(directory, 'unreleased.md'), '## App\n\n### New\n- Something shipped.\n\n## VS Code\n');
  const created = promoteUnreleased(directory, '2.0.0', '2026-03-01');
  assert.equal(path.basename(created), '2.0.0.md');
  assert.match(fs.readFileSync(created, 'utf8'), /^---\nversion: 2\.0\.0\ndate: 2026-03-01\n---\n\n## App/);
  assert.equal(fs.readFileSync(path.join(directory, 'unreleased.md'), 'utf8'), '## App\n\n## VS Code\n');
  assert.throws(() => promoteUnreleased(directory, '2.0.1', '2026-03-02'), /has no bullets/);
});
