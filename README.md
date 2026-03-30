# runework-pipelines

Ready-made pipeline implementations and pipeline runner helpers for `runework`.

Pre-launch development is source-first. This repo expects `runework` to come from a sibling checkout on `main`, and CI does the same.
`runework` stays a peer dependency so local development can point at a checkout instead of a published package.

## Install

```bash
git clone git@github.com:stefan-vatov/runework.git
git clone git@github.com:stefan-vatov/runework-pipelines.git
cd runework
git checkout main
cd ../runework-pipelines
git checkout main
npm ci --ignore-scripts
node ./scripts/install-local-runework.mjs --runework-path ../runework/packages/runework
```

When you need a package spec instead of a sibling checkout, use `runework-pipelines` from `main` and provide `runework` separately.

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
