# Release notes source

One file per release, plus `unreleased.md` for what has not shipped. `bun run changelog:build` renders `CHANGELOG.md` (app), `packages/vscode/CHANGELOG.md` (extension, shown by the Marketplace as is), and `index.json` (for the website). Edit the files here; the generated ones are overwritten.

```markdown
---
version: 1.22.2
date: 2026-09-06
title: optional one-line headline
---

Optional intro paragraph shown above the groups.

## App

### New
- Something the user could not do before.

### Improvements
- Something they could do works better now.

### Fixes
- Something was broken; name the symptom.

### Misc
- Bundled tool versions, packaging, platform support, retirements.

## VS Code

### Fixes
- Only what the extension actually mounts. Written separately, on purpose.
```

Groups may appear in any order in a source file; the generator emits them as New, Improvements, Fixes, Misc and drops empty ones. A release without a `## VS Code` section is absent from the extension changelog. `unreleased.md` has no front matter.

`bun run changelog:check` fails when the generated files are behind their sources; CI runs it. `oc-dev create-release` promotes `unreleased.md` to `<version>.md` with today's date and rebuilds.

How to write a bullet lives in `.agents/skills/changelog-authoring/SKILL.md`.
