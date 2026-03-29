import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runPipeline } from 'runework/pipelines'

import {
  createAgentStreamReporter,
  emitPipelineJob,
  emitPipelineRun,
  type RunnerProgressEvent,
} from './index.ts'

test('lib exports shared pipeline progress helpers', () => {
  assert.equal(typeof createAgentStreamReporter, 'function')
  assert.equal(typeof emitPipelineJob, 'function')
  assert.equal(typeof emitPipelineRun, 'function')
})

test('consumer-authored pipelines can mix runework-pipelines/lib helpers with runework primitives', async (t) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'runework-pipelines-lib-fixture-'))
  t.after(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const repoRoot = join(tmpRoot, 'repo')
  const runeworkDir = join(repoRoot, '.runework')
  await mkdir(join(runeworkDir, 'pipelines'), { recursive: true })
  await mkdir(join(runeworkDir, 'node_modules'), { recursive: true })

  const runeworkPackagePath = join(process.cwd(), '..', 'runework', 'packages', 'runework')
  await symlink(runeworkPackagePath, join(runeworkDir, 'node_modules', 'runework'), 'dir')
  await symlink(process.cwd(), join(runeworkDir, 'node_modules', 'runework-pipelines'), 'dir')

  const pipelineSource = `
import { defineWorkflowPipeline } from 'runework/pipelines'
import {
  createAgentStreamReporter,
  emitPipelineJob,
  emitPipelineRun,
} from 'runework-pipelines/lib'

export default defineWorkflowPipeline({
  version: 1,
  async run(ctx) {
    emitPipelineRun(ctx, {
      pipelineName: 'custom-mixed',
      title: 'Custom Mixed',
      subtitle: 'fixture',
      runId: ctx.runId,
      resumed: ctx.isResume,
    })

    const reporter = createAgentStreamReporter(ctx, {
      id: 'custom:summary',
      label: 'custom summary',
      group: 'custom',
      order: 10,
      provider: 'codex',
    })

    emitPipelineJob(ctx, {
      id: 'custom:summary',
      label: 'custom summary',
      group: 'custom',
      order: 10,
      provider: 'codex',
    }, 'running', 'starting')

    reporter.onOutputChunk({
      provider: 'codex',
      stream: 'stdout',
      text: JSON.stringify({ type: 'turn.started' }) + '\\n',
    })
    reporter.flush()

    const outputPath = await ctx.writeOutput('summary.txt', 'custom helper import works')
    emitPipelineJob(ctx, {
      id: 'custom:summary',
      label: 'custom summary',
      group: 'custom',
      order: 10,
      provider: 'codex',
    }, 'success', 'done')

    return { ok: true, outputPath, summary: 'custom helper import works' }
  },
})
`

  await writeFile(join(runeworkDir, 'pipelines', 'custom-mixed.ts'), pipelineSource, 'utf8')

  const events: RunnerProgressEvent[] = []
  const result = await runPipeline('custom-mixed', runeworkDir, {
    onProgress(event) {
      events.push(event as RunnerProgressEvent)
    },
    log: () => {},
  })

  assert.equal(result.ok, true)
  assert.equal(result.summary, 'custom helper import works')
  assert.ok(result.outputPath)
  assert.equal(await readFile(result.outputPath!, 'utf8'), 'custom helper import works')

  const outputPath = result.outputs?.['summary.txt'] ?? result.outputPath
  assert.ok(outputPath)
  assert.equal(await readFile(outputPath!, 'utf8'), 'custom helper import works')

  const fixturePipelineSource = await readFile(
    join(runeworkDir, 'pipelines', 'custom-mixed.ts'),
    'utf8',
  )
  assert.match(fixturePipelineSource, /from 'runework\/pipelines'/)
  assert.match(fixturePipelineSource, /from 'runework-pipelines\/lib'/)

  assert.deepEqual(
    events.map((event) => event.type),
    ['pipeline:run', 'pipeline:job', 'pipeline:output', 'pipeline:output', 'pipeline:job'],
  )

  const runEvent = events[0]
  assert.equal(runEvent.type, 'pipeline:run')
  assert.equal(runEvent.pipelineName, 'custom-mixed')

  const launchLine = events.find((event) => event.type === 'pipeline:output' && event.text === 'launching codex...')
  assert.ok(launchLine)
  const thinkingLine = events.find((event) => event.type === 'pipeline:output' && event.text === 'thinking...')
  assert.ok(thinkingLine)
})
