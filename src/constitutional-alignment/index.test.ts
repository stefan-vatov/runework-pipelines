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

type FakeCodexConfig = {
  binDir: string
  logPath: string
  reviewText?: string
  alignText?: string
  alignRelativePath?: string
  alignContent?: string
  commitText?: string
  commitScenario?: 'success' | 'fail' | 'invalid-then-fail' | 'invalid-then-success'
  commitStatePath?: string
  delayMs?: string
}

async function createFakeCodexCli(t: { after: (cleanup: () => Promise<void> | void) => void }) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'runework-alignment-fake-codex-'))
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
    "const { spawnSync } = require('node:child_process')",
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
    "const isAlignRun = isWritableRun && stdin.includes('constitutional alignment review')",
    "const isCommitRun = stdin.includes('You are a developer committing code changes.') || stdin.includes('You are a developer fixing a failed commit attempt.')",
    'const alignRelativePath = process.env.RUNEWORK_FAKE_CODEX_ALIGN_RELATIVE_PATH',
    'const alignContent = process.env.RUNEWORK_FAKE_CODEX_ALIGN_CONTENT',
    "const alignText = process.env.RUNEWORK_FAKE_CODEX_ALIGN_TEXT ?? 'aligned the codebase'",
    "const commitScenario = process.env.RUNEWORK_FAKE_CODEX_COMMIT_SCENARIO ?? 'success'",
    'const commitStatePath = process.env.RUNEWORK_FAKE_CODEX_COMMIT_STATE',
    "const commitText = process.env.RUNEWORK_FAKE_CODEX_COMMIT_TEXT ?? 'feat: add changes'",
    "const reviewText = process.env.RUNEWORK_FAKE_CODEX_REVIEW_TEXT ?? '## Must Fix\\n- None\\n\\n## Should Fix\\n- None\\n\\n## Consider\\n- None\\n\\n## Summary\\n- None\\n'",
    "const delayMs = Number(process.env.RUNEWORK_FAKE_CODEX_DELAY_MS ?? '0')",
    "const text = isAlignRun ? alignText : isCommitRun ? commitText : reviewText",
    'if (delayMs > 0) {',
    '  const start = Date.now()',
    '  while (Date.now() - start < delayMs) {}',
    '}',
    "if (isAlignRun && alignRelativePath && alignContent !== undefined) {",
    "  fs.writeFileSync(path.join(process.cwd(), alignRelativePath), alignContent, 'utf8')",
    '}',
    'setTimeout(() => {',
    "  if (isCommitRun) {",
    "    if (commitScenario === 'fail') {",
    "      if (outputFile) fs.writeFileSync(outputFile, '[error] commit failed', 'utf8')",
    "      process.stdout.write(JSON.stringify({ type: 'message', session_id: 'fake-codex-session' }) + '\\n')",
    '      process.exit(1)',
    '    }',
    "    if (commitScenario === 'invalid-then-fail') {",
    "      const rawAttempt = commitStatePath && fs.existsSync(commitStatePath) ? fs.readFileSync(commitStatePath, 'utf8').trim() : '0'",
    "      const attempt = Number(rawAttempt || '0') + 1",
    "      if (commitStatePath) fs.writeFileSync(commitStatePath, String(attempt), 'utf8')",
    '      if (attempt === 1) {',
    "        const commit = spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Bad Commit Message'], { cwd: process.cwd(), encoding: 'utf8' })",
    "        if (outputFile) fs.writeFileSync(outputFile, 'created invalid commit', 'utf8')",
    "        process.stdout.write(JSON.stringify({ type: 'message', session_id: 'fake-codex-session' }) + '\\n')",
    '        process.exit(commit.status ?? 0)',
    '      }',
    "      if (outputFile) fs.writeFileSync(outputFile, '[error] retry failed', 'utf8')",
    "      process.stdout.write(JSON.stringify({ type: 'message', session_id: 'fake-codex-session' }) + '\\n')",
    '      process.exit(1)',
    '    }',
    "    if (commitScenario === 'invalid-then-success') {",
    "      const rawAttempt = commitStatePath && fs.existsSync(commitStatePath) ? fs.readFileSync(commitStatePath, 'utf8').trim() : '0'",
    "      const attempt = Number(rawAttempt || '0') + 1",
    "      if (commitStatePath) fs.writeFileSync(commitStatePath, String(attempt), 'utf8')",
    '      if (attempt === 1) {',
    "        const commit = spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Bad Commit'], { cwd: process.cwd(), encoding: 'utf8' })",
    "        process.stdout.write(JSON.stringify({ type: 'message', session_id: 'fake-codex-session' }) + '\\n')",
    '        process.exit(commit.status ?? 0)',
    '      }',
    "      const amend = spawnSync('git', ['commit', '--amend', '-m', commitText], { cwd: process.cwd(), encoding: 'utf8' })",
    "      if (outputFile) fs.writeFileSync(outputFile, 'amended to valid commit', 'utf8')",
    "      process.stdout.write(JSON.stringify({ type: 'message', session_id: 'fake-codex-session' }) + '\\n')",
    '      process.exit(amend.status ?? 0)',
    '    }',
    "    const commit = spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', commitText], { cwd: process.cwd(), encoding: 'utf8' })",
    "    if (outputFile) fs.writeFileSync(outputFile, text, 'utf8')",
    "    process.stdout.write(JSON.stringify({ type: 'message', session_id: 'fake-codex-session' }) + '\\n')",
    '    process.exit(commit.status ?? 0)',
    '    return',
    '  }',
    "  if (isWritableRun && outputFile) {",
    "    fs.writeFileSync(outputFile, text, 'utf8')",
    '  }',
    "  process.stdout.write(JSON.stringify({ type: 'message', session_id: 'fake-codex-session' }) + '\\n')",
    '}, 0)',
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
  config: FakeCodexConfig,
): void {
  const previous = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    RUNEWORK_FAKE_CODEX_LOG: process.env.RUNEWORK_FAKE_CODEX_LOG,
    RUNEWORK_FAKE_CODEX_REVIEW_TEXT: process.env.RUNEWORK_FAKE_CODEX_REVIEW_TEXT,
    RUNEWORK_FAKE_CODEX_ALIGN_TEXT: process.env.RUNEWORK_FAKE_CODEX_ALIGN_TEXT,
    RUNEWORK_FAKE_CODEX_ALIGN_RELATIVE_PATH: process.env.RUNEWORK_FAKE_CODEX_ALIGN_RELATIVE_PATH,
    RUNEWORK_FAKE_CODEX_ALIGN_CONTENT: process.env.RUNEWORK_FAKE_CODEX_ALIGN_CONTENT,
    RUNEWORK_FAKE_CODEX_COMMIT_TEXT: process.env.RUNEWORK_FAKE_CODEX_COMMIT_TEXT,
    RUNEWORK_FAKE_CODEX_COMMIT_SCENARIO: process.env.RUNEWORK_FAKE_CODEX_COMMIT_SCENARIO,
    RUNEWORK_FAKE_CODEX_COMMIT_STATE: process.env.RUNEWORK_FAKE_CODEX_COMMIT_STATE,
    RUNEWORK_FAKE_CODEX_DELAY_MS: process.env.RUNEWORK_FAKE_CODEX_DELAY_MS,
  }

  process.env.PATH = `${config.binDir}:${previous.PATH ?? ''}`
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.RUNEWORK_FAKE_CODEX_LOG = config.logPath
  if (config.reviewText !== undefined) process.env.RUNEWORK_FAKE_CODEX_REVIEW_TEXT = config.reviewText
  else delete process.env.RUNEWORK_FAKE_CODEX_REVIEW_TEXT
  if (config.alignText !== undefined) process.env.RUNEWORK_FAKE_CODEX_ALIGN_TEXT = config.alignText
  else delete process.env.RUNEWORK_FAKE_CODEX_ALIGN_TEXT
  if (config.alignRelativePath !== undefined) process.env.RUNEWORK_FAKE_CODEX_ALIGN_RELATIVE_PATH = config.alignRelativePath
  else delete process.env.RUNEWORK_FAKE_CODEX_ALIGN_RELATIVE_PATH
  if (config.alignContent !== undefined) process.env.RUNEWORK_FAKE_CODEX_ALIGN_CONTENT = config.alignContent
  else delete process.env.RUNEWORK_FAKE_CODEX_ALIGN_CONTENT
  if (config.commitText !== undefined) process.env.RUNEWORK_FAKE_CODEX_COMMIT_TEXT = config.commitText
  else delete process.env.RUNEWORK_FAKE_CODEX_COMMIT_TEXT
  if (config.commitScenario !== undefined) process.env.RUNEWORK_FAKE_CODEX_COMMIT_SCENARIO = config.commitScenario
  else delete process.env.RUNEWORK_FAKE_CODEX_COMMIT_SCENARIO
  if (config.commitStatePath !== undefined) process.env.RUNEWORK_FAKE_CODEX_COMMIT_STATE = config.commitStatePath
  else delete process.env.RUNEWORK_FAKE_CODEX_COMMIT_STATE
  if (config.delayMs !== undefined) process.env.RUNEWORK_FAKE_CODEX_DELAY_MS = config.delayMs
  else delete process.env.RUNEWORK_FAKE_CODEX_DELAY_MS

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
    if (previous.RUNEWORK_FAKE_CODEX_ALIGN_TEXT === undefined) delete process.env.RUNEWORK_FAKE_CODEX_ALIGN_TEXT
    else process.env.RUNEWORK_FAKE_CODEX_ALIGN_TEXT = previous.RUNEWORK_FAKE_CODEX_ALIGN_TEXT
    if (previous.RUNEWORK_FAKE_CODEX_ALIGN_RELATIVE_PATH === undefined) delete process.env.RUNEWORK_FAKE_CODEX_ALIGN_RELATIVE_PATH
    else process.env.RUNEWORK_FAKE_CODEX_ALIGN_RELATIVE_PATH = previous.RUNEWORK_FAKE_CODEX_ALIGN_RELATIVE_PATH
    if (previous.RUNEWORK_FAKE_CODEX_ALIGN_CONTENT === undefined) delete process.env.RUNEWORK_FAKE_CODEX_ALIGN_CONTENT
    else process.env.RUNEWORK_FAKE_CODEX_ALIGN_CONTENT = previous.RUNEWORK_FAKE_CODEX_ALIGN_CONTENT
    if (previous.RUNEWORK_FAKE_CODEX_COMMIT_TEXT === undefined) delete process.env.RUNEWORK_FAKE_CODEX_COMMIT_TEXT
    else process.env.RUNEWORK_FAKE_CODEX_COMMIT_TEXT = previous.RUNEWORK_FAKE_CODEX_COMMIT_TEXT
    if (previous.RUNEWORK_FAKE_CODEX_COMMIT_SCENARIO === undefined) delete process.env.RUNEWORK_FAKE_CODEX_COMMIT_SCENARIO
    else process.env.RUNEWORK_FAKE_CODEX_COMMIT_SCENARIO = previous.RUNEWORK_FAKE_CODEX_COMMIT_SCENARIO
    if (previous.RUNEWORK_FAKE_CODEX_COMMIT_STATE === undefined) delete process.env.RUNEWORK_FAKE_CODEX_COMMIT_STATE
    else process.env.RUNEWORK_FAKE_CODEX_COMMIT_STATE = previous.RUNEWORK_FAKE_CODEX_COMMIT_STATE
    if (previous.RUNEWORK_FAKE_CODEX_DELAY_MS === undefined) delete process.env.RUNEWORK_FAKE_CODEX_DELAY_MS
    else process.env.RUNEWORK_FAKE_CODEX_DELAY_MS = previous.RUNEWORK_FAKE_CODEX_DELAY_MS
  })
}

async function readFakeCliInvocations(logPath: string): Promise<Array<{ args: string[]; stdin: string }>> {
  const content = await readFile(logPath, 'utf8').catch(() => '')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; stdin: string })
}

async function createConsumerAlignmentRepo(t: { after: (cleanup: () => Promise<void>) => void }) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'runework-alignment-consumer-'))
  t.after(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const repoRoot = join(tmpRoot, 'repo')
  const runeworkDir = join(repoRoot, '.runework')
  await mkdir(join(runeworkDir, 'pipelines'), { recursive: true })
  await mkdir(join(runeworkDir, 'node_modules'), { recursive: true })

  await writeFile(
    join(runeworkDir, 'pipelines', 'constitutional-alignment.ts'),
    "export { default } from 'runework-pipelines/constitutional-alignment'\n",
    'utf8',
  )
  await symlink(
    join(process.cwd(), '..', 'runework', 'packages', 'runework'),
    join(runeworkDir, 'node_modules', 'runework'),
    'dir',
  )
  await symlink(process.cwd(), join(runeworkDir, 'node_modules', 'runework-pipelines'), 'dir')
  await writeFile(join(repoRoot, 'README.md'), '# temp repo\n', 'utf8')
  await writeFile(join(repoRoot, 'CONSTITUTION.md'), '# Constitution\n\n- Preserve durable validation.\n', 'utf8')
  await writeFile(join(repoRoot, '.gitignore'), '.runework/node_modules/\n.runework/.work/\n', 'utf8')

  assertSucceeded(runCommand('git', ['init', '-b', 'main'], repoRoot), 'git init failed')
  assertSucceeded(runCommand('git', ['config', 'user.name', 'Runework Pipelines Tests'], repoRoot), 'git user.name failed')
  assertSucceeded(runCommand('git', ['config', 'user.email', 'runework-alignment@example.com'], repoRoot), 'git user.email failed')
  assertSucceeded(
    runCommand('git', ['add', 'README.md', 'CONSTITUTION.md', '.gitignore', '.runework/pipelines/constitutional-alignment.ts'], repoRoot),
    'git add failed',
  )
  assertSucceeded(
    runCommand('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], repoRoot),
    'git commit failed',
  )

  return { repoRoot, runeworkDir }
}

// Basic package entrypoint tests

test('constitutional-alignment package entrypoint exports a runnable workflow', async () => {
  const { default: alignmentPipeline } = await import('./index.ts')
  assert.equal(typeof alignmentPipeline, 'function')
})

test('constitutional-alignment requires a constitution file to run', async () => {
  const { default: alignmentPipeline } = await import('./index.ts')
  assert.equal(typeof alignmentPipeline, 'function')
  assert.ok(alignmentPipeline)
})

test('constitutional-alignment exports alignment constants for external reference', async () => {
  const source = await import('./index.ts')
  assert.ok(source.default)
  assert.equal(typeof source.default, 'function')
})

// Consumer-style thin re-export tests

test('consumer-style constitutional-alignment re-export runs the package entrypoint through runework runtime', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { runeworkDir } = await createConsumerAlignmentRepo(t)
  const fakeCodex = await createFakeCodexCli(t)

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    alignText: 'aligned the codebase with constitution',
    alignRelativePath: 'README.md',
    alignContent: '# temp repo\nconstitution aligned\n',
    commitText: 'feat: align with constitution',
  })

  const result = await runPipeline('constitutional-alignment', runeworkDir, {
    log: () => {},
  })

  assert.equal(result.ok, true)
  assert.match(result.summary, /2 cycles/)
  assert.ok(result.outputPath)

  const execInvocations = (await readFakeCliInvocations(fakeCodex.logPath))
    .filter((entry) => entry.args.includes('exec'))

  // Should have alignment runs for cycle 1 and 2 (at least 1 alignment call detected)
  const alignInvocations = execInvocations.filter((entry) =>
    entry.stdin.includes('constitutional alignment review'))
  assert.ok(alignInvocations.length >= 1, `Expected at least 1 alignment invocation, got ${alignInvocations.length}`)

  // Should have commit runs - we expect 1 or 2 depending on whether cycle 2 has changes to commit
  const commitInvocations = execInvocations.filter((entry) =>
    entry.stdin.includes('You are a developer committing code changes.') ||
    entry.stdin.includes('You are a developer fixing a failed commit attempt.'))
  assert.ok(commitInvocations.length >= 1, `Expected at least 1 commit invocation, got ${commitInvocations.length}`)
})

// Commit retry tests

test('constitutional-alignment retries commit on failure up to COMMIT_MAX_ATTEMPTS', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { repoRoot, runeworkDir } = await createConsumerAlignmentRepo(t)
  const fakeCodex = await createFakeCodexCli(t)
  const commitStatePath = join(repoRoot, 'commit-state.txt')

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    alignText: 'aligned',
    alignRelativePath: 'README.md',
    alignContent: '# temp repo\naligned\n',
    commitScenario: 'fail',
    commitStatePath,
  })

  await assert.rejects(
    () => runPipeline('constitutional-alignment', runeworkDir, { log: () => {} }),
    /Commit failed after 2 attempts/,
  )

  // Verify that we had 2 commit attempts (one original + one retry)
  const execInvocations = (await readFakeCliInvocations(fakeCodex.logPath))
    .filter((entry) => entry.args.includes('exec'))
  const commitInvocations = execInvocations.filter((entry) =>
    entry.stdin.includes('You are a developer committing code changes.') ||
    entry.stdin.includes('You are a developer fixing a failed commit attempt.'))
  assert.equal(commitInvocations.length, 2)
})

test('constitutional-alignment retries commit when first message is invalid but second is valid', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { repoRoot, runeworkDir } = await createConsumerAlignmentRepo(t)
  const fakeCodex = await createFakeCodexCli(t)
  const commitStatePath = join(repoRoot, 'commit-state.txt')

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    alignText: 'aligned',
    alignRelativePath: 'README.md',
    alignContent: '# temp repo\naligned\n',
    commitScenario: 'invalid-then-success',
    commitStatePath,
    commitText: 'feat: align with constitution',
  })

  const result = await runPipeline('constitutional-alignment', runeworkDir, {
    log: () => {},
  })

  assert.equal(result.ok, true)
  assert.match(result.summary, /2 cycles/)

  // Check that the commit was created successfully after retry
  const lastCommitMsg = runCommand('git', ['log', '-1', '--pretty=%s'], repoRoot).stdout.trim()
  assert.equal(lastCommitMsg, 'feat: align with constitution')
})

// Commit message validation tests

test('constitutional-alignment rejects non-lowercase commit messages', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { repoRoot, runeworkDir } = await createConsumerAlignmentRepo(t)
  const fakeCodex = await createFakeCodexCli(t)

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    alignText: 'aligned',
    alignRelativePath: 'README.md',
    alignContent: '# temp repo\naligned\n',
    commitText: 'Feat: This is WRONG', // uppercase
  })

  await assert.rejects(
    () => runPipeline('constitutional-alignment', runeworkDir, { log: () => {} }),
    /Commit failed after 2 attempts/,
  )

  // Verify that the initial commit was rejected
  const lastCommitMsg = runCommand('git', ['log', '-1', '--pretty=%s'], repoRoot).stdout.trim()
  assert.equal(lastCommitMsg, 'init') // No new commits were created
})

test('constitutional-alignment rejects malformed conventional commit format', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { runeworkDir } = await createConsumerAlignmentRepo(t)
  const fakeCodex = await createFakeCodexCli(t)

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    alignText: 'aligned',
    alignRelativePath: 'README.md',
    alignContent: '# temp repo\naligned\n',
    commitText: 'not a valid commit message at all', // missing colon
  })

  await assert.rejects(
    () => runPipeline('constitutional-alignment', runeworkDir, { log: () => {} }),
    /Commit failed after 2 attempts/,
  )
})

test('constitutional-alignment rejects multi-line commit messages', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { runeworkDir } = await createConsumerAlignmentRepo(t)
  const fakeCodex = await createFakeCodexCli(t)

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    alignText: 'aligned',
    alignRelativePath: 'README.md',
    alignContent: '# temp repo\naligned\n',
    commitText: 'feat: add changes\n\nThis is a body', // multi-line
  })

  await assert.rejects(
    () => runPipeline('constitutional-alignment', runeworkDir, { log: () => {} }),
    /Commit failed after 2 attempts/,
  )
})

// Rollback semantics tests

test('constitutional-alignment rolls back an invalid commit when retries fail', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { repoRoot, runeworkDir } = await createConsumerAlignmentRepo(t)
  const fakeCodex = await createFakeCodexCli(t)
  const commitStatePath = join(repoRoot, 'commit-state.txt')

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    alignText: 'aligned',
    alignRelativePath: 'README.md',
    alignContent: '# temp repo\naligned\n',
    commitScenario: 'invalid-then-fail',
    commitStatePath,
    commitText: 'feat: valid commit',
  })

  await assert.rejects(
    () => runPipeline('constitutional-alignment', runeworkDir, { log: () => {} }),
    /Commit failed after 2 attempts/,
  )

  // Verify that the HEAD is still at init (rollback occurred)
  const head = runCommand('git', ['rev-parse', 'HEAD'], repoRoot).stdout.trim()
  const initCommit = runCommand('git', ['rev-parse', 'init'], repoRoot).stdout.trim() ||
    runCommand('git', ['rev-list', '--max-parents=0', 'HEAD'], repoRoot).stdout.trim()
  assert.ok(head === initCommit || runCommand('git', ['log', '--oneline', '-1'], repoRoot).stdout.includes('init'))

  // Verify that no new commits were created
  const commitCount = runCommand('git', ['rev-list', '--count', 'HEAD'], repoRoot).stdout.trim()
  assert.equal(commitCount, '1') // Only the init commit
})

test('constitutional-alignment rolls back and preserves staged changes after rollback', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { repoRoot, runeworkDir } = await createConsumerAlignmentRepo(t)
  const fakeCodex = await createFakeCodexCli(t)
  const commitStatePath = join(repoRoot, 'commit-state.txt')

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    alignText: 'aligned',
    alignRelativePath: 'README.md',
    alignContent: '# temp repo\naligned\n',
    commitScenario: 'invalid-then-fail',
    commitStatePath,
    commitText: 'feat: valid commit',
  })

  await assert.rejects(
    () => runPipeline('constitutional-alignment', runeworkDir, { log: () => {} }),
    /Commit failed after 2 attempts/,
  )

  // After rollback, the aligned content should be staged
  const stagedChanges = runCommand('git', ['diff', '--cached', '--name-only'], repoRoot).stdout.trim()
  assert.ok(stagedChanges.includes('README.md'), `Expected README.md to be staged, but got: ${stagedChanges}`)

  // The README should have the aligned content
  const readmeContent = await readFile(join(repoRoot, 'README.md'), 'utf8')
  assert.equal(readmeContent, '# temp repo\naligned\n')
})

// Alignment-only scenarios

test('constitutional-alignment skips commit when no changes after alignment', async (t) => {
  const { runPipeline } = await import('../../../runework/packages/runework/src/pipelines/index.ts')
  const { repoRoot, runeworkDir } = await createConsumerAlignmentRepo(t)
  const fakeCodex = await createFakeCodexCli(t)

  withFakeCodexEnv(t, {
    binDir: fakeCodex.binDir,
    logPath: fakeCodex.logPath,
    alignText: 'no deviations found',
    alignRelativePath: 'README.md',
    alignContent: '# temp repo\n', // Same content - no changes
    commitText: 'feat: should not be created',
  })

  const result = await runPipeline('constitutional-alignment', runeworkDir, {
    log: () => {},
  })

  // Should succeed even with no commits created
  assert.equal(result.ok, true)

  // Check that no new commits were created
  const commitCount = runCommand('git', ['rev-list', '--count', 'HEAD'], repoRoot).stdout.trim()
  assert.equal(commitCount, '1') // Only the init commit
})
