# runework

Thin `zx` runtime for durable AI CLI execution. `runework` owns adapters, execution, journaling, templating, and a generic pipeline runtime. It does not ship prompts, review loops, agent rules, or starter workflows.

## Library Usage

```ts
import { getAdapter } from 'runework'

const codex = getAdapter('codex')

const result = await codex.run({
  prompt: 'Summarize this repository',
  cwd: process.cwd(),
})
```

Each adapter result includes `result.command` with the exact `bin`, `args`, and `cwd` used for the underlying CLI invocation.

Provider-specific flags should go through `extraArgs`. Shared request fields stay limited to what the underlying adapter actually supports.

If you only need a one-off prompt, call the provider CLI directly.

## Thin CLI Utilities

Single-provider run:

```bash
npx runework-run codex "Summarize this repository"
```

Single-provider run with structured JSON output:

```bash
npx runework-run --json codex "Summarize this repository"
```

Availability check:

```bash
npx runework-detect
```

Availability check with structured JSON output:

```bash
npx runework-detect --json
```

Scaffold a blank `.runework/` package in another repo:

```bash
npx runework-init /path/to/target-repo
```

Run a user-authored pipeline from that repo:

```bash
cd /path/to/target-repo/.runework
npx runework-pipeline my-pipeline
```

Run a pipeline with the final result emitted as JSON:

```bash
cd /path/to/target-repo/.runework
npx runework-pipeline --json my-pipeline
```

`runework-init` scaffolds an empty `.runework/` package with only `package.json`, `tsconfig.json`, `scripts/`, and `pipelines/`. Prompts, review loops, AGENTS files, and policy stay user-owned.

The repository workspace and dogfood tooling live above this package. This package is the public umbrella surface.
