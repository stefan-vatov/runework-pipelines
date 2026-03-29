import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options?: {
    env?: NodeJS.ProcessEnv
  },
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: options?.env,
  })
}

function assertSucceeded(result: SpawnSyncReturns<string>, label: string): void {
  const detail = result.error?.message
    ?? result.stderr
    ?? result.stdout
    ?? 'command failed without output'
  assert.equal(result.status, 0, `${label}\n${detail}`)
}

function resolveCommandPath(command: string): string {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(locator, [command], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout || `failed to resolve ${command}`)
  const path = result.stdout.split('\n').map((line) => line.trim()).find(Boolean)
  assert.ok(path, `failed to resolve ${command}`)
  return path
}

async function linkExecutable(binDir: string, name: string, target: string): Promise<void> {
  await symlink(target, join(binDir, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
}

async function createFakeCodexCli(t: { after: (cleanup: () => Promise<void> | void) => void }) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'runework-pipelines-fake-codex-'))
  t.after(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const binDir = join(tmpRoot, 'bin')
  const logPath = join(tmpRoot, 'codex-log.jsonl')
  await mkdir(binDir, { recursive: true })

  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const args = process.argv.slice(2)',
    "if (args.includes('--version') || args.includes('-V') || args.includes('version')) {",
    "  process.stdout.write('codex fake 1.0.0\\n')",
    '  process.exit(0)',
    '}',
    "const stdin = fs.readFileSync(0, 'utf8')",
    'const logPath = process.env.RUNEWORK_FAKE_CODEX_LOG',
    "if (logPath) fs.appendFileSync(logPath, JSON.stringify({ args, stdin }) + '\\n')",
    "const outputIndex = args.indexOf('--output-last-message')",
    'const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : undefined',
    "const isWritableRun = args.includes('workspace-write')",
    'const fixRelativePath = process.env.RUNEWORK_FAKE_CODEX_FIX_RELATIVE_PATH',
    'const fixContent = process.env.RUNEWORK_FAKE_CODEX_FIX_CONTENT',
    "const reviewText = process.env.RUNEWORK_FAKE_CODEX_REVIEW_TEXT ?? '## Must Fix\\n- None\\n\\n## Should Fix\\n- None\\n\\n## Consider\\n- None\\n\\n## Summary\\n- None\\n'",
    "const fixText = process.env.RUNEWORK_FAKE_CODEX_FIX_TEXT ?? 'applied fixes'",
    'const text = isWritableRun ? fixText : reviewText',
    'if (isWritableRun && fixRelativePath && fixContent !== undefined) {',
    "  fs.writeFileSync(path.join(process.cwd(), fixRelativePath), fixContent, 'utf8')",
    '}',
    "if (outputFile) fs.writeFileSync(outputFile, text, 'utf8')",
    "process.stdout.write(JSON.stringify({ type: 'message', session_id: 'fake-codex-session' }) + '\\n')",
  ].join('\n')

  const scriptPath = join(binDir, 'codex')
  await writeFile(scriptPath, script, 'utf8')
  await chmod(scriptPath, 0o755)
  const locator = process.platform === 'win32' ? 'where' : 'which'
  await Promise.all([
    linkExecutable(binDir, 'git', resolveCommandPath('git')),
    linkExecutable(binDir, 'node', process.execPath),
    linkExecutable(binDir, locator, resolveCommandPath(locator)),
  ])

  return { binDir, logPath }
}

function withFakeCodexEnv(
  t: { after: (cleanup: () => void) => void },
  config: {
    binDir: string
    logPath: string
    reviewText: string
    fixText?: string
    fixRelativePath?: string
    fixContent?: string
  },
): void {
  const previous = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    RUNEWORK_FAKE_CODEX_LOG: process.env.RUNEWORK_FAKE_CODEX_LOG,
    RUNEWORK_FAKE_CODEX_REVIEW_TEXT: process.env.RUNEWORK_FAKE_CODEX_REVIEW_TEXT,
    RUNEWORK_FAKE_CODEX_FIX_TEXT: process.env.RUNEWORK_FAKE_CODEX_FIX_TEXT,
    RUNEWORK_FAKE_CODEX_FIX_RELATIVE_PATH: process.env.RUNEWORK_FAKE_CODEX_FIX_RELATIVE_PATH,
    RUNEWORK_FAKE_CODEX_FIX_CONTENT: process.env.RUNEWORK_FAKE_CODEX_FIX_CONTENT,
  }

  process.env.PATH = `${config.binDir}:${previous.PATH ?? ''}`
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.RUNEWORK_FAKE_CODEX_LOG = config.logPath
  process.env.RUNEWORK_FAKE_CODEX_REVIEW_TEXT = config.reviewText
  if (config.fixText !== undefined) process.env.RUNEWORK_FAKE_CODEX_FIX_TEXT = config.fixText
  else delete process.env.RUNEWORK_FAKE_CODEX_FIX_TEXT
  if (config.fixRelativePath !== undefined) process.env.RUNEWORK_FAKE_CODEX_FIX_RELATIVE_PATH = config.fixRelativePath
  else delete process.env.RUNEWORK_FAKE_CODEX_FIX_RELATIVE_PATH
  if (config.fixContent !== undefined) process.env.RUNEWORK_FAKE_CODEX_FIX_CONTENT = config.fixContent
  else delete process.env.RUNEWORK_FAKE_CODEX_FIX_CONTENT

  t.after(() => {
    process.env.PATH = previous.PATH
    if (previous.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previous.GIT_CONFIG_GLOBAL
    if (previous.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = previous.GIT_CONFIG_NOSYSTEM
    if (previous.RUNEWORK_FAKE_CODEX_LOG === undefined) delete process.env.RUNEWORK_FAKE_CODEX_LOG
    else process.env.RUNEWORK_FAKE_CODEX_LOG = previous.RUNEWORK_FAKE_CODEX_LOG
    if (previous.RUNEWORK_FAKE_CODEX_REVIEW_TEXT === undefined) delete process.env.RUNEWORK_FAKE_CODEX_REVIEW_TEXT
    else process.env.RUNEWORK_FAKE_CODEX_REVIEW_TEXT = previous.RUNEWORK_FAKE_CODEX_REVIEW_TEXT
    if (previous.RUNEWORK_FAKE_CODEX_FIX_TEXT === undefined) delete process.env.RUNEWORK_FAKE_CODEX_FIX_TEXT
    else process.env.RUNEWORK_FAKE_CODEX_FIX_TEXT = previous.RUNEWORK_FAKE_CODEX_FIX_TEXT
    if (previous.RUNEWORK_FAKE_CODEX_FIX_RELATIVE_PATH === undefined) delete process.env.RUNEWORK_FAKE_CODEX_FIX_RELATIVE_PATH
    else process.env.RUNEWORK_FAKE_CODEX_FIX_RELATIVE_PATH = previous.RUNEWORK_FAKE_CODEX_FIX_RELATIVE_PATH
    if (previous.RUNEWORK_FAKE_CODEX_FIX_CONTENT === undefined) delete process.env.RUNEWORK_FAKE_CODEX_FIX_CONTENT
    else process.env.RUNEWORK_FAKE_CODEX_FIX_CONTENT = previous.RUNEWORK_FAKE_CODEX_FIX_CONTENT
  })
}

async function readFakeCliInvocations(logPath: string): Promise<Array<{ args: string[]; stdin: string }>> {
  const content = await readFile(logPath, 'utf8').catch(() => '')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; stdin: string })
}

async function createConsumerRuneworkRepo(t: { after: (cleanup: () => Promise<void>) => void }) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'runework-pipelines-consumer-'))
  t.after(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const repoRoot = join(tmpRoot, 'repo')
  const runeworkDir = join(repoRoot, '.runework')
  await mkdir(join(runeworkDir, 'pipelines'), { recursive: true })
  await mkdir(join(runeworkDir, 'node_modules'), { recursive: true })

  await writeFile(
    join(runeworkDir, 'pipelines', 'code-review.ts'),
    "export { default } from 'runework-pipelines/code-review'\n",
    'utf8',
  )
  await symlink(
    join(process.cwd(), '..', 'runework', 'packages', 'runework'),
    join(runeworkDir, 'node_modules', 'runework'),
    'dir',
  )
  await symlink(process.cwd(), join(runeworkDir, 'node_modules', 'runework-pipelines'), 'dir')
  await writeFile(join(repoRoot, 'README.md'), '# temp repo\n', 'utf8')
  await writeFile(join(repoRoot, '.gitignore'), '.runework/node_modules/\n.runework/.work/\n', 'utf8')

  assertSucceeded(runCommand('git', ['init', '-b', 'main'], repoRoot), 'git init failed')
  assertSucceeded(runCommand('git', ['config', 'user.name', 'Runework Pipelines Tests'], repoRoot), 'git user.name failed')
  assertSucceeded(runCommand('git', ['config', 'user.email', 'runework-pipelines@example.com'], repoRoot), 'git user.email failed')
  assertSucceeded(
    runCommand('git', ['add', 'README.md', '.gitignore', '.runework/pipelines/code-review.ts'], repoRoot),
    'git add failed',
  )
  assertSucceeded(
    runCommand('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], repoRoot),
    'git commit failed',
  )

  return { repoRoot, runeworkDir }
}

test('code-review package entrypoint exports a runnable workflow', async () => {
  const { default: codeReviewPipeline } = await import('./index.ts')
  assert.equal(typeof codeReviewPipeline, 'function')
})

test('code-review rejects resume when invocation flags change', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { runeworkDir } = await createConsumerRuneworkRepo(t)
  const fakeCodex = await createFakeCodexCli(t)

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    reviewText: [
      '## Must Fix',
      '- None',
      '',
      '## Should Fix',
      '- None',
      '',
      '## Consider',
      '- None',
      '',
      '## Summary',
      '- None',
      '',
    ].join('\n'),
  })

  const runId = 'runework-pipelines-resume-flags'
  await assert.rejects(
    () =>
      runPipeline('code-review', runeworkDir, {
        runId,
        options: {
          scope: '__runework_missing_review_scope__',
          cycles: 2,
          fix: true,
          opencodeModel: 'zai/glm-5',
        },
        log: () => {},
      }),
    /Invalid review scope "__runework_missing_review_scope__"/,
  )

  await assert.rejects(
    () =>
      runPipeline('code-review', runeworkDir, {
        resumeRunId: runId,
        options: {
          scope: 'all',
          cycles: 1,
          fix: false,
          opencodeModel: 'openai/gpt-5.4-mini',
        },
        log: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Cannot resume run runework-pipelines-resume-flags/)
      assert.match(error.message, /"cycles"/)
      assert.match(error.message, /"fix"/)
      assert.match(error.message, /"opencodeModel"/)
      assert.match(error.message, /"scope"/)
      return true
    },
  )
})

test('consumer-style pipeline re-export runs the package entrypoint through runework runtime', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { repoRoot, runeworkDir } = await createConsumerRuneworkRepo(t)
  const fakeCodex = await createFakeCodexCli(t)

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    reviewText: [
      '## Must Fix',
      '- [README.md:2] Remove the unreviewed line so the tree is clean again.',
      '',
      '## Should Fix',
      '- None',
      '',
      '## Consider',
      '- None',
      '',
      '## Summary',
      '- One actionable fix.',
      '',
    ].join('\n'),
    fixText: 'restored README.md to the committed content',
    fixRelativePath: 'README.md',
    fixContent: '# temp repo\n',
  })

  await writeFile(join(repoRoot, 'README.md'), '# temp repo\nneeds review\n', 'utf8')

  const result = await runPipeline('code-review', runeworkDir, {
    log: () => {},
  })

  assert.equal(result.ok, true)
  assert.match(result.summary, /2 cycles/)
  assert.match(result.summary, /with fixes/)
  assert.ok(result.outputs)

  const finalReview = await readFile(result.outputs!['final-review.md'], 'utf8')
  assert.match(finalReview, /Remove the unreviewed line/)
  assert.doesNotMatch(finalReview, /No changes to review/)
  assert.equal(await readFile(join(repoRoot, 'README.md'), 'utf8'), '# temp repo\n')

  const execInvocations = (await readFakeCliInvocations(fakeCodex.logPath))
    .filter((entry) => entry.args.includes('exec'))
  assert.equal(execInvocations.length, 3)
  assert.equal(execInvocations.filter((entry) => entry.args.includes('workspace-write')).length, 1)
})
