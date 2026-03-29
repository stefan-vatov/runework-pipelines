import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

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
})

test('public subpaths resolve through the package boundary', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=source',
      '--input-type=module',
      '-e',
      `
const [codeReview, constitutionalAlignment, lib] = await Promise.all([
  import('runework-pipelines/code-review'),
  import('runework-pipelines/constitutional-alignment'),
  import('runework-pipelines/lib'),
])

if (typeof codeReview.default !== 'function') {
  throw new Error('code-review default export should be a pipeline function')
}

if (typeof constitutionalAlignment.default !== 'function') {
  throw new Error('constitutional-alignment default export should be a pipeline function')
}

if (typeof lib.createPendingPipelineError !== 'function') {
  throw new Error('lib should expose createPendingPipelineError')
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
