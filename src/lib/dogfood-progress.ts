import { safeJsonParse, type AgentOutputChunk } from 'runework'
import type { PipelineProgressEvent } from 'runework/pipelines'

export type DogfoodJobStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cached'

export type DogfoodRunProgressEvent = {
  type: 'dogfood:run'
  pipelineName: string
  title: string
  subtitle?: string
  runId: string
  resumed: boolean
}

export type DogfoodJobDescriptor = {
  id: string
  label: string
  group: string
  order: number
  provider?: string
  cycle?: number
}

export type DogfoodJobProgressEvent = {
  type: 'dogfood:job'
  jobId: string
  label: string
  group: string
  order: number
  status: DogfoodJobStatus
  detail?: string
  provider?: string
  cycle?: number
}

export type DogfoodOutputProgressEvent = {
  type: 'dogfood:output'
  jobId: string
  provider?: string
  stream: 'stdout' | 'stderr'
  text: string
}

export type DogfoodProgressEvent =
  | DogfoodRunProgressEvent
  | DogfoodJobProgressEvent
  | DogfoodOutputProgressEvent

type DogfoodProgressSink = {
  progress(event: PipelineProgressEvent): void
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function emitProgress(
  sink: DogfoodProgressSink,
  event: DogfoodProgressEvent,
): void {
  sink.progress(event as PipelineProgressEvent)
}

function dedupeTexts(texts: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const text of texts) {
    const normalized = text.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(text)
  }

  return result
}

function extractJsonTexts(value: unknown): string[] {
  if (!isRecord(value)) return []

  const record = value
  if (record.type === 'thread.started') return ['session started']
  if (record.type === 'turn.started') return ['thinking...']

  const delta = isRecord(record.delta) ? record.delta : undefined
  const part = isRecord(record.part) ? record.part : undefined
  const item = isRecord(record.item) ? record.item : undefined
  const message = isRecord(record.message) ? record.message : undefined
  const texts = [
    normalizeText(part?.text),
    item?.type === 'agent_message' ? normalizeText(item.text) : undefined,
    normalizeText(record.delta),
    normalizeText(record.text),
    normalizeText(record.result),
    normalizeText(delta?.text),
    normalizeText(delta?.partial_json),
    normalizeText(message?.text),
  ].flatMap((entry) => entry ? [entry] : [])

  return dedupeTexts(texts)
}

function emitOutputLines(
  sink: DogfoodProgressSink,
  job: DogfoodJobDescriptor,
  stream: 'stdout' | 'stderr',
  text: string,
): void {
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue
    emitProgress(sink, {
      type: 'dogfood:output',
      jobId: job.id,
      provider: job.provider,
      stream,
      text: line,
    })
  }
}

function flushLines(
  sink: DogfoodProgressSink,
  job: DogfoodJobDescriptor,
  stream: 'stdout' | 'stderr',
  buffer: string,
  parseJson: boolean,
): string {
  let remaining = buffer
  let newlineIndex = remaining.indexOf('\n')

  while (newlineIndex >= 0) {
    const rawLine = remaining.slice(0, newlineIndex).replace(/\r$/, '')
    remaining = remaining.slice(newlineIndex + 1)

    if (parseJson) {
      const parsed = safeJsonParse(rawLine)
      const texts = parsed === undefined ? [rawLine] : extractJsonTexts(parsed)
      for (const text of texts) emitOutputLines(sink, job, stream, text)
    } else {
      emitOutputLines(sink, job, stream, rawLine)
    }

    newlineIndex = remaining.indexOf('\n')
  }

  return remaining
}

export function emitDogfoodRun(
  sink: DogfoodProgressSink,
  event: Omit<DogfoodRunProgressEvent, 'type'>,
): void {
  emitProgress(sink, { type: 'dogfood:run', ...event })
}

export function emitDogfoodJob(
  sink: DogfoodProgressSink,
  job: DogfoodJobDescriptor,
  status: DogfoodJobStatus,
  detail?: string,
): void {
  emitProgress(sink, {
    type: 'dogfood:job',
    jobId: job.id,
    label: job.label,
    group: job.group,
    order: job.order,
    status,
    detail,
    provider: job.provider,
    cycle: job.cycle,
  })
}

export function createAgentStreamReporter(
  sink: DogfoodProgressSink,
  job: DogfoodJobDescriptor,
): {
  onOutputChunk(chunk: AgentOutputChunk): void
  flush(): void
} {
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let didEmitLaunchLine = false

  return {
    onOutputChunk(chunk) {
      if (!didEmitLaunchLine && job.provider) {
        didEmitLaunchLine = true
        emitOutputLines(sink, job, 'stdout', `launching ${job.provider}...`)
      }

      if (chunk.stream === 'stdout') {
        stdoutBuffer = flushLines(sink, job, 'stdout', stdoutBuffer + chunk.text, true)
        return
      }

      stderrBuffer = flushLines(sink, job, 'stderr', stderrBuffer + chunk.text, false)
    },
    flush() {
      if (stdoutBuffer.trim()) {
        const parsed = safeJsonParse(stdoutBuffer)
        const texts = parsed === undefined ? [stdoutBuffer] : extractJsonTexts(parsed)
        for (const text of texts) emitOutputLines(sink, job, 'stdout', text)
        stdoutBuffer = ''
      }

      if (stderrBuffer.trim()) {
        emitOutputLines(sink, job, 'stderr', stderrBuffer)
        stderrBuffer = ''
      }
    },
  }
}
