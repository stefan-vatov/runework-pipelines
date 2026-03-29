# runework-pipelines

Ready-made pipeline implementations and pipeline runner helpers for `runework`.

Pre-launch distribution is GitHub-tag based. Consumers should install tagged GitHub refs instead of npm registry versions.

## Install

```json
{
  "dependencies": {
    "runework": "github:stefan-vatov/runework#v0.2.0",
    "runework-pipelines": "github:stefan-vatov/runework-pipelines#v0.1.0"
  }
}
```

For local development against a sibling `runework` checkout:

```bash
npm run install:local-runework
```

## Usage

Thin re-export stubs keep `.runework/` user-owned while importing shared pipeline logic from this repo:

```ts
export { default } from 'runework-pipelines/code-review'
```

```ts
export { default } from 'runework-pipelines/constitutional-alignment'
```

Shared pipeline progress helpers are exported from `runework-pipelines/lib`.

The local development pipeline UI and CLI helpers are exported from `runework-pipelines/runner`.
