import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export { runPipeline } from 'runework/pipelines'

export const runeworkPackageRoot = join(
  dirname(fileURLToPath(import.meta.resolve('runework/pipelines'))),
  '..',
  '..',
)
