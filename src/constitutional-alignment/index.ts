import { detectTools } from 'runework'
import { defineWorkflowPipeline } from 'runework/pipelines'
import type { PipelineContext, PipelineResult } from 'runework/pipelines'
import { $ } from 'runework/zx'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  createAgentStreamReporter,
  emitPipelineJob,
  emitPipelineRun,
  type PipelineJobDescriptor,
} from '../lib/index.ts'

const CODEX_MODEL = 'gpt-5.4'
const CODEX_EXTRA_ARGS = ['--config', 'model_reasoning_effort=xhigh']
const ALIGNMENT_SANDBOX = 'workspace-write'
const ALIGNMENT_APPROVAL_MODE = 'never'
const COMMIT_SANDBOX = 'danger-full-access'
const COMMIT_APPROVAL_MODE = 'never'
const ALIGNMENT_CYCLE_COUNT = 2
const COMMIT_MAX_ATTEMPTS = 2

type AlignmentConfig = {
  constitutionPath: string
  constitutionText: string
  availableTools: string[]
}

type AlignmentRuntimeState = {
  codexAvailable: boolean
  alignmentText: string
  alignmentPath: string
  alignmentOk: boolean
  commitText: string
  commitPath: string
  commitOk: boolean
  commitSkipped: boolean
  commitMessage: string
  commitCount: number
  skippedCommitCount: number
}

type AlignmentStatePatch = Partial<AlignmentRuntimeState>

type AlignmentPhaseContext = {
  readonly repoRoot: string
  readonly config: Readonly<AlignmentConfig>
  readonly state: Readonly<AlignmentRuntimeState>
  readonly cycle: number
  readonly codexAdapter: PipelineContext['adapters'][string]
  log(message: string): void
  progress: PipelineContext['progress']
  writeOutput(filename: string, content: string): Promise<string>
  writePhaseOutput(filename: string, content: string): Promise<string>
}

const pipeline = defineWorkflowPipeline({
  version: 2,

  async run(ctx) {
    const config = await buildConfig(ctx.repoRoot)
    await ensureStableConfig(ctx, 'config', config)
    emitPipelineRun(ctx, {
      pipelineName: 'constitutional-alignment',
      title: 'Constitutional Alignment',
      subtitle: `${ALIGNMENT_CYCLE_COUNT} cycles • ${CODEX_MODEL}`,
      runId: ctx.runId,
      resumed: ctx.isResume,
    })

    let state = buildInitialState()

    state = applyStatePatch(
      state,
      await ctx.step('prepare:detect-tools', () =>
        detectAvailableToolsJob(createAlignmentPhaseContext(ctx, config, state, 0, 'prepare')),
      ),
    )

    for (let cycle = 1; cycle <= ALIGNMENT_CYCLE_COUNT; cycle += 1) {
      state = applyStatePatch(
        state,
        await ctx.step(`cycle:${cycle}:align:review-and-fix`, () =>
          reviewAndFix(createAlignmentPhaseContext(ctx, config, state, cycle, `cycle-${cycle}/align`)),
        ),
      )

      state = applyStatePatch(
        state,
        await ctx.step(`cycle:${cycle}:commit:commit-changes`, () =>
          commitChanges(createAlignmentPhaseContext(ctx, config, state, cycle, `cycle-${cycle}/commit`)),
        ),
      )
    }

    return buildResult(state)
  },
})

export default pipeline

async function buildConfig(repoRoot: string): Promise<AlignmentConfig> {
  const constitutionPath = resolve(repoRoot, 'CONSTITUTION.md')
  let constitutionText: string
  try {
    constitutionText = await readFile(constitutionPath, 'utf-8')
  } catch {
    throw new Error(`Constitution file not found at ${constitutionPath}`)
  }

  const availableTools = (await detectTools())
    .filter((tool) => tool.available)
    .map((tool) => tool.name)
    .sort()

  return { constitutionPath, constitutionText, availableTools }
}

function buildInitialState(): AlignmentRuntimeState {
  return {
    codexAvailable: false,
    alignmentText: '',
    alignmentPath: '',
    alignmentOk: false,
    commitText: '',
    commitPath: '',
    commitOk: false,
    commitSkipped: false,
    commitMessage: '',
    commitCount: 0,
    skippedCommitCount: 0,
  }
}

function createAlignmentPhaseContext(
  ctx: PipelineContext,
  config: AlignmentConfig,
  state: AlignmentRuntimeState,
  cycle: number,
  phaseOutputDir: string,
): AlignmentPhaseContext {
  return {
    repoRoot: ctx.repoRoot,
    config,
    state,
    cycle,
    codexAdapter: ctx.adapters.codex,
    log: ctx.log,
    progress: ctx.progress,
    writeOutput: ctx.writeOutput,
    writePhaseOutput(filename, content) {
      return ctx.writeOutput(join(phaseOutputDir, filename), content)
    },
  }
}

function buildDetectToolsJobDescriptor(): PipelineJobDescriptor {
  return {
    id: 'prepare:detect-tools',
    label: 'detect tools',
    group: 'prepare',
    order: 10,
    cycle: 0,
  }
}

function buildAlignmentJobDescriptor(cycle: number): PipelineJobDescriptor {
  return {
    id: `cycle:${cycle}:align:review-and-fix`,
    label: 'constitutional alignment',
    group: `cycle ${cycle} / align`,
    order: 10,
    provider: 'codex',
    cycle,
  }
}

function buildCommitJobDescriptor(cycle: number): PipelineJobDescriptor {
  return {
    id: `cycle:${cycle}:commit:commit-changes`,
    label: 'create commit',
    group: `cycle ${cycle} / commit`,
    order: 10,
    provider: 'codex',
    cycle,
  }
}

function applyStatePatch(
  state: AlignmentRuntimeState,
  patch: AlignmentStatePatch | void,
): AlignmentRuntimeState {
  return patch ? { ...state, ...patch } : state
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function listChangedKeys(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  return [...keys]
    .filter((key) => !isDeepStrictEqual(previous[key], next[key]))
    .sort()
}

async function ensureStableConfig(
  ctx: PipelineContext,
  checkpointId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const previous = await ctx.getCheckpoint<Record<string, unknown>>(checkpointId)
  if (!previous) {
    await ctx.checkpoint(checkpointId, config)
    return
  }

  const changedKeys = listChangedKeys(previous, config)
  if (changedKeys.length === 0) return

  throw new Error(
    `Cannot resume run ${ctx.runId}: configuration changed for ${changedKeys
      .map((key) => JSON.stringify(key))
      .join(', ')}`,
  )
}

function buildAlignmentPrompt(constitutionText: string): string {
  return `You are a senior engineer performing a constitutional alignment review.

Below is the project's CONSTITUTION.md — the source of truth for this codebase's founding principles, boundaries, growth directives, and tension pairs.

<constitution>
${constitutionText}
</constitution>

Your task:
1. Read and internalize every principle, boundary, directive, and tension pair in the constitution.
2. Inspect the repository's source code, configuration, documentation, and tests.
3. Identify any deviations — places where the implementation contradicts, ignores, or undermines a constitutional principle.
4. Fix every deviation you find directly in the codebase.

Decision policy:
- The constitution is the only normative source in this pipeline. Current code, documentation, tests, and repo-local pipeline workflows are evidence about the repo, not authority over the constitution.
- Do NOT use existing documentation, comments, or current implementation to justify behavior that conflicts with the constitution.
- Treat documentation as potentially stale or wrong. If docs conflict with the constitution, align docs to the constitution after fixing the underlying code or package surface.
- Prefer changing implementation to satisfy the constitution over deleting validation that exposes the problem.
- Treat tests, typechecks, publish checks, smoke tests, and repo-local pipeline flows as contract evidence, not disposable cleanup targets.
- If a repo-local workflow is too opinionated or uses the wrong abstraction, rewrite it onto runework primitives instead of removing the coverage it provides.
- Keep the runtime on primitives, but do not achieve that by weakening verification of existing behavior.

Rules:
- In this repository, committed .runework/ files are the sanctioned repo-local and consumer-owned workflow boundary. They are intentionally in-tree for this repo's own development and validation.
- Do NOT create a parallel helper boundary outside .runework/ just to make the architecture look cleaner on paper.
- If a .runework/ file leaks into the published runtime contract, fix the package surface, docs, or validation around publication instead of relocating the repo-local workflow files.
- Do NOT edit files under .runework/.work/ or any generated pipeline artifacts.
- Do NOT add features, abstractions, or code beyond what is needed to resolve deviations.
- Do NOT delete, narrow, bypass, or weaken tests/checks just to make the repo appear constitutionally aligned.
- Do NOT change tests merely to match a regression or newly introduced behavior.
- Only remove or substantially rewrite validation when the underlying contract is intentionally removed, and in the same change add equivalent or stronger replacement coverage.
- If a deviation can be fixed either by changing implementation or by loosening validation, choose the implementation change.
- If you are unsure whether a test or repo-local workflow is guarding an intentional contract, stop and leave it in place.
- Stay idiomatic to the existing codebase style.
- If a deviation is ambiguous, favor the constitutional principle over current implementation.
- Do NOT cite README text, docs prose, or comments as the reason a constitutional deviation is acceptable.

Execution sequence:
1. Identify the principle being violated and the concrete files involved.
2. Preserve or strengthen the relevant validation before considering any cleanup.
3. Make the minimal implementation changes needed to satisfy the constitution.
4. Run relevant checks so the repo remains green without removing safeguards.

After making changes, write a brief summary that names:
- which constitutional principle each change serves
- which tests/checks/validation were preserved or strengthened
- any validation you intentionally replaced, and what replaced it`
}

const COMMIT_PROMPT = `You are a developer committing code changes.

Inspect the currently staged changes with git diff --cached.

Create exactly ONE conventional commit. Requirements:
- One line only, no body
- All lowercase
- Format: type: subject  OR  type(scope): subject
- Valid types: feat, fix, refactor, docs, chore, test, style, perf, ci, build
- Keep the subject concise and descriptive

Run: git commit -m "<your message>"

If the commit fails for any reason (hooks, lint, tests, formatting):
1. Read the error output carefully
2. Fix the issue in the affected files
3. Run git add -A to restage
4. Retry the commit

Do NOT push, tag, or create branches.`

function buildRetryCommitPrompt(previousFailure: string, previousCreatedCommit: boolean): string {
  const amendNote = previousCreatedCommit
    ? `A commit was created but the message was invalid. Use git commit --amend -m "<new message>" to fix it.`
    : `No commit was created. Fix the issue, run git add -A, then git commit -m "<your message>".`

  return `You are a developer fixing a failed commit attempt.

Previous failure reason:
${previousFailure}

${amendNote}

Requirements for the commit message:
- One line only, no body
- All lowercase
- Format: type: subject  OR  type(scope): subject
- Valid types: feat, fix, refactor, docs, chore, test, style, perf, ci, build

If any pre-commit hooks or checks fail, fix the issues first, restage with git add -A, then commit.
Do NOT push, tag, or create branches.`
}

async function gitStdout(
  repoRoot: string,
  args: string[],
  errorPrefix: string,
  okExitCodes: number[] = [0],
): Promise<string> {
  const result = await $({ cwd: repoRoot, nothrow: true, quiet: true })`git ${args}`
  const exitCode = result.exitCode ?? 0
  if (!okExitCodes.includes(exitCode)) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} exited with code ${exitCode}`
    throw new Error(`${errorPrefix}: ${detail}`)
  }
  return result.stdout.trim()
}

async function gitExitCode(repoRoot: string, args: string[]): Promise<number> {
  const result = await $({ cwd: repoRoot, nothrow: true, quiet: true })`git ${args}`
  return result.exitCode ?? 0
}

async function getHead(repoRoot: string): Promise<string | undefined> {
  try {
    return await gitStdout(repoRoot, ['rev-parse', '--verify', 'HEAD'], '')
  } catch {
    return undefined
  }
}

async function hasStagedChanges(repoRoot: string): Promise<boolean> {
  const code = await gitExitCode(repoRoot, ['diff', '--cached', '--quiet'])
  return code !== 0
}

async function rollbackCommit(repoRoot: string, head: string | undefined): Promise<void> {
  if (!head) {
    throw new Error('Cannot roll back failed commit: repository had no initial HEAD')
  }

  await $({ cwd: repoRoot, quiet: true })`git reset --soft ${head}`
}

async function getLatestCommitMessage(repoRoot: string): Promise<string> {
  return gitStdout(repoRoot, ['log', '-1', '--pretty=%B'], 'Failed to read commit message')
}

const CONVENTIONAL_COMMIT_RE = /^[a-z]+(\([a-z0-9_/-]+\))?!?:\s.+$/

function validateConventionalCommit(message: string): string | undefined {
  const lines = message.trim().split('\n').filter(Boolean)
  if (lines.length !== 1) return `expected one line, got ${lines.length}`
  const subject = lines[0]
  if (subject !== subject.toLowerCase()) return `not all lowercase: "${subject}"`
  if (!CONVENTIONAL_COMMIT_RE.test(subject)) return `does not match conventional commit format: "${subject}"`
  return undefined
}

function summarizeFailureDetail(text: string): string {
  const firstLine = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)

  if (!firstLine) return 'failed'

  const normalized = firstLine.replace(/^\[error\]\s*/i, '')
  if (!normalized) return 'failed'
  if (normalized.length <= 120) return normalized
  return `${normalized.slice(0, 117)}...`
}

async function detectAvailableToolsJob(ctx: AlignmentPhaseContext): Promise<AlignmentStatePatch> {
  const job = buildDetectToolsJobDescriptor()
  emitPipelineJob(ctx, job, 'running', 'checking installed CLI tools')
  const codexAvailable = ctx.config.availableTools.includes('codex')

  if (!codexAvailable) {
    emitPipelineJob(ctx, job, 'failed', 'codex unavailable')
    throw new Error(
      'constitutional-alignment requires Codex CLI because alignment needs writable workspace access and commit retries need full git metadata access. ' +
      'Install codex and try again.',
    )
  }

  ctx.log(`tools: ${ctx.config.availableTools.join(', ')}`)
  ctx.log(`model: ${CODEX_MODEL} (xhigh reasoning)`)
  ctx.log(`cycles: ${ALIGNMENT_CYCLE_COUNT}`)

  const status = await gitStdout(ctx.repoRoot, ['status', '--short'], 'Failed to get git status')
  if (status) {
    const fileCount = status.split('\n').filter(Boolean).length
    ctx.log(`working tree has ${fileCount} dirty file(s) — these will be included in commits`)
  }

  emitPipelineJob(ctx, job, 'success', ctx.config.availableTools.join(', '))

  return { codexAvailable }
}

async function reviewAndFix(ctx: AlignmentPhaseContext): Promise<AlignmentStatePatch> {
  const job = buildAlignmentJobDescriptor(ctx.cycle)
  emitPipelineJob(ctx, job, 'running', `cycle ${ctx.cycle}`)
  const prompt = buildAlignmentPrompt(ctx.config.constitutionText)
  const streamReporter = createAgentStreamReporter(ctx, job)

  let text: string
  let ok: boolean
  try {
    const result = await ctx.codexAdapter.run({
      prompt,
      cwd: ctx.repoRoot,
      model: CODEX_MODEL,
      sandbox: ALIGNMENT_SANDBOX,
      approvalMode: ALIGNMENT_APPROVAL_MODE,
      extraArgs: CODEX_EXTRA_ARGS,
      timeoutMs: 60 * 60 * 1000,
      onOutputChunk: streamReporter.onOutputChunk,
    })
    text = result.text
    ok = result.ok
  } catch (error) {
    if (isAbortError(error)) throw error
    text = `[error] ${error instanceof Error ? error.message : String(error)}`
    ok = false
  } finally {
    streamReporter.flush()
  }

  await ctx.writePhaseOutput('constitutional-alignment.md', text)
  const path = await ctx.writeOutput('constitutional-alignment.md', text)
  const detail = ok ? `${text.split('\n').length} lines` : summarizeFailureDetail(text)

  ctx.log(`alignment: ${ok ? 'done' : 'failed'} (${detail}) → ${path}`)
  emitPipelineJob(
    ctx,
    job,
    ok ? 'success' : 'failed',
    detail,
  )

  if (!ok) throw new Error(`Alignment pass failed — see ${path}`)

  return {
    alignmentText: text,
    alignmentPath: path,
    alignmentOk: ok,
  }
}

async function commitChanges(ctx: AlignmentPhaseContext): Promise<AlignmentStatePatch> {
  const job = buildCommitJobDescriptor(ctx.cycle)
  emitPipelineJob(ctx, job, 'running', 'staging changes')
  await $({ cwd: ctx.repoRoot, quiet: true })`git add -A`

  if (!await hasStagedChanges(ctx.repoRoot)) {
    const text = 'No staged changes after alignment — nothing to commit.'
    await ctx.writePhaseOutput('commit-result.md', text)
    const path = await ctx.writeOutput('commit-result.md', text)
    ctx.log('no changes to commit — skipping')
    emitPipelineJob(ctx, job, 'success', 'no changes to commit')
    return {
      commitPath: path,
      commitOk: true,
      commitSkipped: true,
      skippedCommitCount: ctx.state.skippedCommitCount + 1,
    }
  }

  const initialHead = await getHead(ctx.repoRoot)
  let lastFailure: string | undefined
  let lastCreatedCommit = false
  let needsRollback = false

  for (let attempt = 1; attempt <= COMMIT_MAX_ATTEMPTS; attempt += 1) {
    const headBefore = await getHead(ctx.repoRoot)
    const prompt = attempt === 1
      ? COMMIT_PROMPT
      : buildRetryCommitPrompt(lastFailure!, lastCreatedCommit)
    emitPipelineJob(
      ctx,
      job,
      'running',
      `attempt ${attempt} of ${COMMIT_MAX_ATTEMPTS}`,
    )
    const streamReporter = createAgentStreamReporter(ctx, job)

    let text: string
    let ok: boolean
    try {
      const result = await ctx.codexAdapter.run({
        prompt,
        cwd: ctx.repoRoot,
        model: CODEX_MODEL,
        sandbox: COMMIT_SANDBOX,
        approvalMode: COMMIT_APPROVAL_MODE,
        extraArgs: CODEX_EXTRA_ARGS,
        timeoutMs: 30 * 60 * 1000,
        onOutputChunk: streamReporter.onOutputChunk,
      })
      text = result.text
      ok = result.ok
    } catch (error) {
      if (isAbortError(error)) throw error
      text = `[error] ${error instanceof Error ? error.message : String(error)}`
      ok = false
    } finally {
      streamReporter.flush()
    }

    await ctx.writePhaseOutput(`commit-attempt-${attempt}.md`, text)

    const headAfter = await getHead(ctx.repoRoot)
    const commitCreated = Boolean(headAfter && headBefore !== headAfter)

    if (commitCreated) {
      const message = await getLatestCommitMessage(ctx.repoRoot)
      const validationError = validateConventionalCommit(message)

      if (!validationError) {
        const resultText = `Commit created (attempt ${attempt}):\n${message.trim()}`
        await ctx.writePhaseOutput('commit-result.md', resultText)
        const path = await ctx.writeOutput('commit-result.md', resultText)
        ctx.log(`committed: ${message.trim()} → ${path}`)
        emitPipelineJob(ctx, job, 'success', message.trim())
        return {
          commitText: text,
          commitPath: path,
          commitOk: true,
          commitSkipped: false,
          commitMessage: message.trim(),
          commitCount: ctx.state.commitCount + 1,
        }
      }

      lastFailure = `commit message validation failed: ${validationError}`
      lastCreatedCommit = true
      needsRollback = true
    } else {
      lastFailure = ok
        ? 'model reported success but no new commit was created'
        : summarizeFailureDetail(text)
      lastCreatedCommit = false

      if (attempt < COMMIT_MAX_ATTEMPTS) {
        await $({ cwd: ctx.repoRoot, quiet: true })`git add -A`
      }
    }

    if (attempt < COMMIT_MAX_ATTEMPTS) {
      ctx.log(`commit attempt ${attempt} failed: ${lastFailure} — retrying`)
    }
  }

  if (needsRollback) {
    try {
      await rollbackCommit(ctx.repoRoot, initialHead)
      ctx.log('rolled back invalid commit after final failure')
    } catch (rollbackError) {
      const rollbackDetail = rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError)
      lastFailure = `${lastFailure}; rollback failed: ${rollbackDetail}`
    }
  }

  const failText = `Commit failed after ${COMMIT_MAX_ATTEMPTS} attempts.\nLast failure: ${lastFailure}`
  await ctx.writePhaseOutput('commit-result.md', failText)
  const failPath = await ctx.writeOutput('commit-result.md', failText)
  emitPipelineJob(ctx, job, 'failed', lastFailure)
  throw new Error(`Commit failed after ${COMMIT_MAX_ATTEMPTS} attempts: ${lastFailure} — see ${failPath}`)
}

function buildResult(state: Readonly<AlignmentRuntimeState>): PipelineResult {
  const parts = [`${ALIGNMENT_CYCLE_COUNT} cycles`]
  if (state.commitCount > 0) parts.push(`${state.commitCount} commit${state.commitCount !== 1 ? 's' : ''}`)
  if (state.skippedCommitCount > 0) parts.push(`${state.skippedCommitCount} no-op${state.skippedCommitCount !== 1 ? 's' : ''}`)

  return {
    ok: state.alignmentOk && state.commitOk,
    outputPath: state.commitPath || state.alignmentPath,
    summary: `Constitutional alignment complete (${parts.join(', ')})`,
  }
}
