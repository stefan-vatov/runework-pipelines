import { createElement, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdin, useStdout } from 'ink'
import { listPipelines, runPipeline, type PipelineResult } from 'runework/pipelines'
import type {
  PipelineJobProgressEvent,
  PipelineJobStatus,
  PipelineOutputProgressEvent,
  RunnerProgressEvent,
  PipelineRunProgressEvent,
} from '../lib/index.ts'

export type RunPipelineRunnerOptions = {
  pipelineName: string
  runeworkDir: string
  pipelineOptions: Record<string, unknown>
  resumeRunId?: string
}

export type ParsedPipelineCliArgs = {
  pipelineName?: string
  resumeRunId?: string
  pipelineOptions: Record<string, unknown>
  plain: boolean
}

type PipelineOutputLine = {
  stream: 'stdout' | 'stderr'
  text: string
}

type PipelineViewportLine = {
  stream: 'stdout' | 'stderr'
  text: string
}

type PipelineJobState = {
  id: string
  label: string
  group: string
  order: number
  status: PipelineJobStatus
  detail?: string
  provider?: string
  cycle?: number
  output: PipelineOutputLine[]
}

type PipelineUiState = {
  pipelineName: string
  title: string
  subtitle?: string
  runId?: string
  resumed: boolean
  jobs: Record<string, PipelineJobState>
  result?: PipelineResult
  exitCode?: number
  error?: string
}

type PipelineUiAction =
  | { type: 'progress'; event: RunnerProgressEvent }
  | { type: 'done'; result: PipelineResult }
  | { type: 'error'; message: string }

type ExitKeyState = {
  ctrl?: boolean
  meta?: boolean
}

const MAX_OUTPUT_LINES = 200
const h = createElement
const MIN_STREAM_HEIGHT = 10
const RESERVED_SCREEN_LINES = 8
const ENABLE_MOUSE_SCROLL = '\u001B[?1000h\u001B[?1006h'
const DISABLE_MOUSE_SCROLL = '\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1005l\u001B[?1006l\u001B[?1015l\u001B[?25h'
const STREAM_TEXT_COLOR = '#f5f7ff'
const STREAM_ERROR_COLOR = '#ffb0b0'

export function parsePipelineCliArgs(argv: string[]): ParsedPipelineCliArgs {
  const [pipelineName, ...rest] = argv
  const pipelineOptions: Record<string, unknown> = {}
  let resumeRunId: string | undefined
  let plain = false

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)
    const next = rest[index + 1]

    if (key === 'resume-run') {
      if (!next || next.startsWith('--')) {
        throw new Error('--resume-run requires a run ID')
      }

      resumeRunId = next
      index += 1
      continue
    }

    if (key === 'plain') {
      plain = true
      continue
    }

    if (next && !next.startsWith('--')) {
      pipelineOptions[key] = next
      index += 1
    } else {
      pipelineOptions[key] = true
    }
  }

  return { pipelineName, resumeRunId, pipelineOptions, plain }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function humanizePipelineName(name: string): string {
  return name
    .split(/[-_/]/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function isRunnerProgressEvent(event: unknown): event is RunnerProgressEvent {
  return (
    typeof event === 'object'
    && event !== null
    && 'type' in event
    && typeof (event as { type?: unknown }).type === 'string'
    && (event as { type: string }).type.startsWith('pipeline:')
  )
}

function trimOutput(lines: PipelineOutputLine[]): PipelineOutputLine[] {
  return lines.slice(-MAX_OUTPUT_LINES)
}

function jobStatusColor(status: PipelineJobStatus): string {
  switch (status) {
    case 'success':
      return 'green'
    case 'failed':
      return 'red'
    case 'skipped':
    case 'cached':
      return 'yellow'
    case 'running':
      return 'cyan'
  }
}

function jobStatusLabel(status: PipelineJobStatus): string {
  switch (status) {
    case 'success':
      return 'done'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
    case 'cached':
      return 'cached'
    case 'running':
      return 'running'
  }
}

function stripLeadingTimestamp(text: string): string {
  return text.replace(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/,
    '',
  )
}

function collapseRepeatedOutputLines(lines: PipelineOutputLine[]): PipelineOutputLine[] {
  const collapsed: PipelineOutputLine[] = []
  let pendingError:
    | {
      key: string
      text: string
      count: number
    }
    | undefined

  const flushPendingError = () => {
    if (!pendingError) return

    collapsed.push({
      stream: 'stderr',
      text: pendingError.count > 1
        ? `${pendingError.text} [x${pendingError.count}]`
        : pendingError.text,
    })
    pendingError = undefined
  }

  for (const line of lines) {
    if (line.stream !== 'stderr') {
      flushPendingError()
      collapsed.push(line)
      continue
    }

    const normalized = stripLeadingTimestamp(line.text).trim()
    if (!normalized) continue

    if (pendingError?.key === normalized) {
      pendingError.count += 1
      continue
    }

    flushPendingError()
    pendingError = {
      key: normalized,
      text: normalized,
      count: 1,
    }
  }

  flushPendingError()
  return collapsed
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return []

  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ['']

  const lines: string[] = []
  let current = ''

  const pushSegment = (segment: string) => {
    if (Array.from(segment).length <= width) {
      if (!current) {
        current = segment
        return
      }

      const candidate = `${current} ${segment}`
      if (Array.from(candidate).length <= width) {
        current = candidate
        return
      }

      lines.push(current)
      current = segment
      return
    }

    if (current) {
      lines.push(current)
      current = ''
    }

    const chars = Array.from(segment)
    for (let index = 0; index < chars.length; index += width) {
      lines.push(chars.slice(index, index + width).join(''))
    }
  }

  for (const segment of normalized.split(' ')) {
    pushSegment(segment)
  }

  if (current) lines.push(current)
  return lines
}

function wrapOutputLine(
  line: PipelineOutputLine,
  width: number,
): PipelineViewportLine[] {
  const firstPrefix = line.stream === 'stderr' ? '! ' : '› '
  const continuationPrefix = '  '
  const firstWidth = Math.max(1, width - Array.from(firstPrefix).length)
  const continuationWidth = Math.max(1, width - Array.from(continuationPrefix).length)

  const wrapped = wrapText(line.text, firstWidth)
  if (wrapped.length === 0) {
    return [{ stream: line.stream, text: firstPrefix.trimEnd() }]
  }

  return wrapped.flatMap((segment, index) => {
    if (index === 0) {
      return [{ stream: line.stream, text: `${firstPrefix}${segment}` }]
    }

    return wrapText(segment, continuationWidth).map((continued) => ({
      stream: line.stream,
      text: `${continuationPrefix}${continued}`,
    }))
  })
}

function clampScrollOffset(
  scrollOffset: number,
  totalLines: number,
  height: number,
): number {
  return Math.min(
    Math.max(0, scrollOffset),
    Math.max(0, totalLines - height),
  )
}

function buildWrappedViewportLines(
  lines: PipelineOutputLine[],
  width: number,
): PipelineViewportLine[] {
  return collapseRepeatedOutputLines(lines)
    .flatMap((line) => wrapOutputLine(line, Math.max(1, width)))
}

export function extractMouseWheelDelta(input: string): number {
  let delta = 0

  for (const match of input.matchAll(/\u001B\[<(\d+);\d+;\d+[mM]/g)) {
    const button = Number(match[1])
    if ((button & 64) !== 64) continue

    const wheelButton = button & 0b11
    if (wheelButton === 0) {
      delta += 1
      continue
    }

    if (wheelButton === 1) {
      delta -= 1
    }
  }

  return delta
}

export function getExitRequestCode(
  input: string,
  key: ExitKeyState,
): number | undefined {
  if (input === '\u0003') {
    return 0
  }

  if (input === 'q' && !key.ctrl && !key.meta) {
    return 0
  }

  if (input === 'c' && key.ctrl) {
    return 0
  }

  return undefined
}

export function buildStreamViewportLines(
  lines: PipelineOutputLine[],
  width: number,
  height: number,
  scrollOffset = 0,
): PipelineViewportLine[] {
  const wrapped = buildWrappedViewportLines(lines, width)

  if (height <= 0) return []

  const clampedScrollOffset = clampScrollOffset(scrollOffset, wrapped.length, height)
  const endIndex = wrapped.length - clampedScrollOffset
  const startIndex = Math.max(0, endIndex - height)
  const visibleLines = wrapped.slice(startIndex, endIndex)

  if (visibleLines.length >= height) return visibleLines

  return [
    ...Array.from({ length: height - visibleLines.length }, () => ({
      stream: 'stdout' as const,
      text: '',
    })),
    ...visibleLines,
  ]
}

function uiReducer(state: PipelineUiState, action: PipelineUiAction): PipelineUiState {
  switch (action.type) {
    case 'progress':
      return applyProgressEvent(state, action.event)
    case 'done':
      return {
        ...state,
        result: action.result,
        exitCode: action.result.ok ? 0 : 1,
      }
    case 'error':
      return {
        ...state,
        error: action.message,
        exitCode: 1,
      }
  }
}

function applyProgressEvent(
  state: PipelineUiState,
  event: RunnerProgressEvent,
): PipelineUiState {
  switch (event.type) {
    case 'pipeline:run':
      return applyRunEvent(state, event)
    case 'pipeline:job':
      return applyJobEvent(state, event)
    case 'pipeline:output':
      return applyOutputEvent(state, event)
  }
}

function applyRunEvent(
  state: PipelineUiState,
  event: PipelineRunProgressEvent,
): PipelineUiState {
  return {
    ...state,
    pipelineName: event.pipelineName,
    title: event.title,
    subtitle: event.subtitle,
    runId: event.runId,
    resumed: event.resumed,
  }
}

function applyJobEvent(
  state: PipelineUiState,
  event: PipelineJobProgressEvent,
): PipelineUiState {
  const current = state.jobs[event.jobId]
  return {
    ...state,
    jobs: {
      ...state.jobs,
      [event.jobId]: {
        id: event.jobId,
        label: event.label,
        group: event.group,
        order: event.order,
        status: event.status,
        detail: event.detail,
        provider: event.provider,
        cycle: event.cycle,
        output: current?.output ?? [],
      },
    },
  }
}

function applyOutputEvent(
  state: PipelineUiState,
  event: PipelineOutputProgressEvent,
): PipelineUiState {
  const current = state.jobs[event.jobId] ?? {
    id: event.jobId,
    label: event.jobId,
    group: 'activity',
    order: 999,
    status: 'running' as PipelineJobStatus,
    provider: event.provider,
    output: [],
  }

  return {
    ...state,
    jobs: {
      ...state.jobs,
      [event.jobId]: {
        ...current,
        output: trimOutput([
          ...current.output,
          { stream: event.stream, text: event.text },
        ]),
      },
    },
  }
}

function createInitialState(pipelineName: string): PipelineUiState {
  return {
    pipelineName,
    title: humanizePipelineName(pipelineName),
    jobs: {},
    resumed: false,
  }
}

function renderStatusIndicator(job: PipelineJobState) {
  if (job.status === 'running') {
    return h(Text, { color: 'cyan' }, '›')
  }

  const symbol = job.status === 'success'
    ? '●'
    : job.status === 'failed'
      ? '●'
      : '○'

  return h(Text, { color: jobStatusColor(job.status) }, symbol)
}

function getPrimaryJob(jobs: PipelineJobState[]): PipelineJobState | undefined {
  return jobs.find((job) => job.status === 'running')
    ?? [...jobs].reverse().find((job) => job.output.length > 0)
    ?? jobs[jobs.length - 1]
}

function renderActiveJob(job: PipelineJobState | undefined, width: number) {
  const base = job
    ? `${job.group} · ${job.label}${job.detail ? `  ${job.detail}` : ''}`
    : 'waiting to start...'

  return h(
    Box,
    { marginBottom: 1 },
    h(Box, { width: 2 }, job ? renderStatusIndicator(job) : h(Text, { dimColor: true }, '·')),
    h(
      Text,
      { color: STREAM_TEXT_COLOR, wrap: 'truncate-end' },
      wrapText(base, Math.max(1, width))[0] ?? '',
    ),
  )
}

function renderStreamBox(
  job: PipelineJobState | undefined,
  width: number,
  height: number,
  scrollOffset: number,
) {
  const lines = buildStreamViewportLines(job?.output ?? [], width, height, scrollOffset)
  const borderColor = job?.status === 'failed' ? 'red' : 'cyan'

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: 'cyan', bold: true }, 'stream'),
    h(
      Box,
      {
        borderStyle: 'round',
        borderColor,
        flexDirection: 'column',
        paddingX: 1,
        paddingY: 0,
        height: height + 2,
      },
      ...lines.map((line, index) =>
        h(
          Box,
          { key: `${job?.id ?? 'stream'}:${line.stream}:${index}`, height: 1 },
          h(
            Text,
            {
              color: line.text
                ? (line.stream === 'stderr' ? STREAM_ERROR_COLOR : STREAM_TEXT_COLOR)
                : 'gray',
              dimColor: !line.text,
              wrap: 'truncate-end',
            },
            line.text || ' ',
          ),
        )),
    ),
  )
}

function renderOutputs(outputs: Record<string, string> | undefined) {
  if (!outputs || Object.keys(outputs).length === 0) return null

  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { color: 'cyan', bold: true }, 'outputs'),
    ...Object.entries(outputs).slice(0, 6).map(([label, path]) =>
      h(
        Box,
        { key: label, marginLeft: 2 },
        h(Text, { wrap: 'truncate-middle' }, `${label}: `, h(Text, { dimColor: true }, path)),
      )),
  )
}

function formatPlainJobEvent(event: PipelineJobProgressEvent): string {
  const detail = event.detail ? ` — ${event.detail}` : ''
  return `[${event.group}] ${event.label}: ${jobStatusLabel(event.status)}${detail}`
}

function formatPlainOutputEvent(
  event: PipelineOutputProgressEvent,
  labels: Map<string, string>,
): string {
  const label = labels.get(event.jobId) ?? event.jobId
  const stream = event.stream === 'stderr' ? 'stderr' : 'stdout'
  return `[${label}] ${stream}: ${event.text}`
}

function PipelineApp(props: RunPipelineRunnerOptions) {
  const { exit } = useApp()
  const { stdin } = useStdin()
  const { stdout, write } = useStdout()
  const [state, dispatch] = useReducer(uiReducer, createInitialState(props.pipelineName))
  const [streamScrollOffset, setStreamScrollOffset] = useState(0)
  const abortControllerRef = useRef(new AbortController())
  const previousPrimaryJobIdRef = useRef<string | undefined>(undefined)
  const requestedExitCodeRef = useRef<number | undefined>(undefined)
  const requestExitRef = useRef<(code?: number) => void>(() => {})
  const runSettledRef = useRef(false)

  const requestExit = (code = 0) => {
    if (requestedExitCodeRef.current !== undefined) return

    requestedExitCodeRef.current = code

    if (stdout.isTTY) {
      write(DISABLE_MOUSE_SCROLL)
    }

    if (!abortControllerRef.current.signal.aborted) {
      abortControllerRef.current.abort()
    }

    if (runSettledRef.current) {
      exit(code)
    }
  }

  requestExitRef.current = requestExit

  useEffect(() => {
    let active = true

    void (async () => {
      try {
        const result = await runPipeline(props.pipelineName, props.runeworkDir, {
          options: props.pipelineOptions,
          resumeRunId: props.resumeRunId,
          signal: abortControllerRef.current.signal,
          log: () => {},
          onProgress: (event) => {
            if (active && isRunnerProgressEvent(event)) {
              dispatch({ type: 'progress', event })
            }
          },
        })

        if (!active) return
        runSettledRef.current = true
        if (requestedExitCodeRef.current !== undefined) {
          exit(requestedExitCodeRef.current)
          return
        }
        dispatch({ type: 'done', result })
      } catch (error) {
        if (!active) return

        runSettledRef.current = true
        if (requestedExitCodeRef.current !== undefined && isAbortError(error)) {
          exit(requestedExitCodeRef.current)
          return
        }

        dispatch({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })()

    return () => {
      active = false
    }
  }, [props.pipelineName, props.pipelineOptions, props.resumeRunId, props.runeworkDir])

  useEffect(() => {
    if (state.exitCode === undefined) return

    const timer = setTimeout(() => {
      exit(state.exitCode)
    }, 80)

    return () => clearTimeout(timer)
  }, [exit, state.exitCode])

  const jobs = Object.values(state.jobs).sort((left, right) => {
    const leftCycle = left.cycle ?? Number.MAX_SAFE_INTEGER
    const rightCycle = right.cycle ?? Number.MAX_SAFE_INTEGER
    if (leftCycle !== rightCycle) return leftCycle - rightCycle
    if (left.group !== right.group) return left.group.localeCompare(right.group)
    if (left.order !== right.order) return left.order - right.order
    return left.label.localeCompare(right.label)
  })

  const primaryJob = getPrimaryJob(jobs)
  const columns = stdout.columns ?? process.stdout.columns ?? 80
  const rows = stdout.rows ?? process.stdout.rows ?? 24
  const contentWidth = Math.max(20, columns - 4)
  const streamHeight = Math.max(
    MIN_STREAM_HEIGHT,
    rows - RESERVED_SCREEN_LINES,
  )
  const wrappedOutputLines = buildWrappedViewportLines(primaryJob?.output ?? [], contentWidth)
  const maxStreamScrollOffset = Math.max(0, wrappedOutputLines.length - streamHeight)

  useEffect(() => {
    if (previousPrimaryJobIdRef.current === primaryJob?.id) return

    previousPrimaryJobIdRef.current = primaryJob?.id
    setStreamScrollOffset(0)
  }, [primaryJob?.id])

  useEffect(() => {
    setStreamScrollOffset((current) =>
      clampScrollOffset(current, wrappedOutputLines.length, streamHeight))
  }, [streamHeight, wrappedOutputLines.length])

  useEffect(() => {
    if (!stdout.isTTY || !stdin.isTTY) return

    write(ENABLE_MOUSE_SCROLL)
    return () => {
      write(DISABLE_MOUSE_SCROLL)
    }
  }, [stdin.isTTY, stdout.isTTY, write])

  useEffect(() => {
    const handleInput = (chunk: Buffer | string) => {
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const exitCode = getExitRequestCode(data, {})
      if (exitCode !== undefined) {
        requestExitRef.current(exitCode)
        return
      }

      const delta = extractMouseWheelDelta(data)
      if (delta === 0) return

      setStreamScrollOffset((current) =>
        clampScrollOffset(
          current + delta,
          wrappedOutputLines.length,
          streamHeight,
        ))
    }

    stdin.on('data', handleInput)
    return () => {
      stdin.off('data', handleInput)
    }
  }, [stdin, streamHeight, wrappedOutputLines.length])

  useEffect(() => {
    const handleSigint = () => {
      requestExitRef.current(0)
    }

    process.on('SIGINT', handleSigint)
    return () => {
      process.off('SIGINT', handleSigint)
    }
  }, [])

  useInput((_input, key) => {
    const exitCode = getExitRequestCode(_input, key)
    if (exitCode !== undefined) {
      requestExit(exitCode)
      return
    }

    if (maxStreamScrollOffset === 0) return

    if (key.upArrow) {
      setStreamScrollOffset((current) =>
        clampScrollOffset(current + 1, wrappedOutputLines.length, streamHeight))
      return
    }

    if (key.downArrow) {
      setStreamScrollOffset((current) =>
        clampScrollOffset(current - 1, wrappedOutputLines.length, streamHeight))
      return
    }

    if (key.pageUp) {
      setStreamScrollOffset((current) =>
        clampScrollOffset(
          current + Math.max(1, streamHeight - 1),
          wrappedOutputLines.length,
          streamHeight,
        ))
      return
    }

    if (key.pageDown) {
      setStreamScrollOffset((current) =>
        clampScrollOffset(
          current - Math.max(1, streamHeight - 1),
          wrappedOutputLines.length,
          streamHeight,
        ))
      return
    }

    if (key.home) {
      setStreamScrollOffset(maxStreamScrollOffset)
      return
    }

    if (key.end) {
      setStreamScrollOffset(0)
    }
  })

  const headerStatus = state.error
    ? h(Text, { color: 'red', bold: true }, 'failed')
    : state.result
      ? h(Text, { color: state.result.ok ? 'green' : 'red', bold: true }, state.result.ok ? 'complete' : 'failed')
      : h(Text, { color: 'cyan', bold: true }, 'running')

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { marginBottom: 0 },
      h(Text, { bold: true }, state.title),
      h(Text, {}, '  '),
      headerStatus,
      h(Text, { dimColor: true }, `  run ${state.runId ?? 'starting...'}`),
      state.resumed ? h(Text, { color: 'yellow' }, '  resumed') : null,
    ),
    h(
      Text,
      { dimColor: true, wrap: 'truncate-end' },
      wrapText(state.subtitle ?? ' ', Math.max(1, columns))[0] ?? ' ',
    ),
    renderActiveJob(primaryJob, contentWidth),
    renderStreamBox(primaryJob, contentWidth, streamHeight, streamScrollOffset),
    state.result
      ? h(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        h(Text, { color: state.result.ok ? 'green' : 'red', bold: true }, state.result.summary),
        renderOutputs(state.result.outputs),
      )
      : null,
    state.error
      ? h(
        Box,
        { marginTop: 1 },
        h(Text, { color: 'red', bold: true, wrap: 'truncate-end' }, state.error),
      )
      : null,
  )
}

export async function runPipelineWithInk(
  options: RunPipelineRunnerOptions,
): Promise<number> {
  const instance = render(h(PipelineApp, options), {
    patchConsole: false,
    maxFps: 20,
    incrementalRendering: false,
    exitOnCtrlC: false,
  })

  try {
    const result = await instance.waitUntilExit()
    return typeof result === 'number' ? result : 0
  } finally {
    instance.cleanup()

    if (process.stdout.isTTY) {
      process.stdout.write(DISABLE_MOUSE_SCROLL)
    }
  }
}

export async function runPipelinePlain(
  options: RunPipelineRunnerOptions,
): Promise<number> {
  try {
    const jobLabels = new Map<string, string>()
    const result = await runPipeline(options.pipelineName, options.runeworkDir, {
      options: options.pipelineOptions,
      resumeRunId: options.resumeRunId,
      log: (message) => {
        console.error(message)
      },
      onProgress: (event) => {
        if (!isRunnerProgressEvent(event)) return

        switch (event.type) {
          case 'pipeline:run':
            console.error(`${event.title} — run ${event.runId}${event.resumed ? ' (resumed)' : ''}`)
            return
          case 'pipeline:job':
            jobLabels.set(event.jobId, event.label)
            console.error(formatPlainJobEvent(event))
            return
          case 'pipeline:output':
            console.error(formatPlainOutputEvent(event, jobLabels))
        }
      },
    })

    console.error(result.summary)
    if (result.runId) console.error(`run: ${result.runId}`)
    if (result.outputs) {
      for (const [label, path] of Object.entries(result.outputs)) {
        console.error(`${label}: ${path}`)
      }
    }
    return result.ok ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${message}`)
    return 1
  }
}

export async function runPipelineCli(
  argv: string[],
  runeworkDir: string,
): Promise<number> {
  const parsed = parsePipelineCliArgs(argv)

  if (!parsed.pipelineName) {
    const available = await listPipelines(runeworkDir)
    console.error('Usage: node scripts/pipeline.ts <pipeline-name> [--resume-run <run-id>] [--key value...]')
    if (available.length > 0) {
      console.error(`\nAvailable pipelines: ${available.join(', ')}`)
    }
    return 1
  }

  const runner = parsed.plain || !process.stdout.isTTY
    ? runPipelinePlain
    : runPipelineWithInk

  return runner({
    pipelineName: parsed.pipelineName,
    runeworkDir,
    pipelineOptions: parsed.pipelineOptions,
    resumeRunId: parsed.resumeRunId,
  })
}
