import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

test('package manifest exposes the supported public subpath exports', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    exports?: Record<string, Record<string, string>>
  }

  assert.deepEqual(packageJson.exports?.['./code-review'], {
    source: './src/code-review/index.ts',
    types: './dist/code-review/index.d.ts',
    default: './dist/code-review/index.js',
  })
  assert.deepEqual(packageJson.exports?.['./constitutional-alignment'], {
    source: './src/constitutional-alignment/index.ts',
    types: './dist/constitutional-alignment/index.d.ts',
    default: './dist/constitutional-alignment/index.js',
  })
  assert.deepEqual(packageJson.exports?.['./lib'], {
    source: './src/lib/index.ts',
    types: './dist/lib/index.d.ts',
    default: './dist/lib/index.js',
  })
  assert.deepEqual(packageJson.exports?.['./runner'], {
    source: './src/runner/index.ts',
    types: './dist/runner/index.d.ts',
    default: './dist/runner/index.js',
  })
})

test('public subpaths resolve through the package boundary', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=source',
      '--input-type=module',
      '-e',
      `
const [codeReview, constitutionalAlignment, lib, runner] = await Promise.all([
  import('runework-pipelines/code-review'),
  import('runework-pipelines/constitutional-alignment'),
  import('runework-pipelines/lib'),
  import('runework-pipelines/runner'),
])

if (typeof codeReview.default !== 'function') {
  throw new Error('code-review default export should be a pipeline function')
}

if (typeof constitutionalAlignment.default !== 'function') {
  throw new Error('constitutional-alignment default export should be a pipeline function')
}

if (typeof lib.createAgentStreamReporter !== 'function') {
  throw new Error('lib should expose createAgentStreamReporter')
}

if (typeof runner.runPipelinePlain !== 'function') {
  throw new Error('runner should expose runPipelinePlain')
}
      `,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  )

  assert.equal(result.status, 0, result.stderr)
})

test('private source paths stay unexported to consumers', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=source',
      '--input-type=module',
      '-e',
      `
try {
  await import('runework-pipelines/src/code-review/index.ts')
  throw new Error('private source path unexpectedly resolved')
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    process.exit(0)
  }

  throw error
}
      `,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  )

  assert.equal(result.status, 0, result.stderr)
})

test('packed tarball contains only the supported runtime surface', async (t) => {
  const packDir = await mkdtemp(join(tmpdir(), 'runework-pipelines-pack-'))
  t.after(async () => {
    await rm(packDir, { recursive: true, force: true })
  })

  const buildResult = spawnSync(
    npmCommand,
    ['run', 'build'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  )

  assert.equal(buildResult.status, 0, buildResult.stderr)

  const result = spawnSync(
    npmCommand,
    ['pack', '--json', '--pack-destination', packDir],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  )

  assert.equal(result.status, 0, result.stderr)

  const [packInfo] = JSON.parse(result.stdout) as Array<{
    files: Array<{ path: string }>
  }>
  const packedPaths = new Set(packInfo.files.map((file) => file.path))

  assert.ok(packedPaths.has('README.md'))
  assert.ok(packedPaths.has('LICENSE'))
  assert.ok(packedPaths.has('dist/code-review/index.js'))
  assert.ok(packedPaths.has('dist/runner/index.js'))
  assert.ok(packedPaths.has('src/code-review/index.ts'))
  assert.ok(packedPaths.has('src/constitutional-alignment/index.ts'))
  assert.ok(packedPaths.has('src/runner/index.ts'))
  assert.ok(packedPaths.has('src/lib/pipeline-progress.ts'))
  assert.equal(
    Array.from(packedPaths).some((path) => path.endsWith('.test.ts')),
    false,
    'packed tarball should not ship test files',
  )
  assert.equal(
    packedPaths.has('scripts/build.mjs'),
    false,
    'packed tarball should not ship local build tooling',
  )
})
