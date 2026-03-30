import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  createLocalRuneworkInstallPlan,
  defaultLocalRuneworkPath,
  toLocalRuneworkInstallSpec,
} from './index.ts'

test('package manifest declares runework as a peer dependency', async () => {
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), 'package.json'), 'utf8'),
  ) as { peerDependencies?: Record<string, string> }

  assert.equal(packageJson.peerDependencies?.runework, '*')
})

test('defaultLocalRuneworkPath points at the sibling runework package checkout', () => {
  assert.equal(
    defaultLocalRuneworkPath('/tmp/work/runework-pipelines'),
    '/tmp/work/runework/packages/runework',
  )
})

test('toLocalRuneworkInstallSpec produces an explicit file override', () => {
  assert.equal(
    toLocalRuneworkInstallSpec('/tmp/runework/packages/runework'),
    'runework@file:/tmp/runework/packages/runework',
  )
})

test('createLocalRuneworkInstallPlan keeps temporary overrides explicit and command passthrough intact', () => {
  const plan = createLocalRuneworkInstallPlan(
    [
      '--runework-path',
      '../custom-runework/packages/runework',
      '--',
      'npm',
      'test',
    ],
    '/tmp/work/runework-pipelines',
  )

  assert.equal(
    plan.runeworkPath,
    '/tmp/work/custom-runework/packages/runework',
  )
  assert.equal(
    plan.installSpec,
    'runework@file:/tmp/work/custom-runework/packages/runework',
  )
  assert.deepEqual(plan.command, ['npm', 'test'])
})

test('createLocalRuneworkInstallPlan accepts npm-run passthrough arguments without an explicit separator', () => {
  const plan = createLocalRuneworkInstallPlan(
    [
      '--runework-path',
      '../custom-runework/packages/runework',
      'node',
      '--input-type=module',
      '-e',
      "console.log('ok')",
    ],
    '/tmp/work/runework-pipelines',
  )

  assert.equal(
    plan.installSpec,
    'runework@file:/tmp/work/custom-runework/packages/runework',
  )
  assert.deepEqual(plan.command, [
    'node',
    '--input-type=module',
    '-e',
    "console.log('ok')",
  ])
})
