export class PendingPipelineExportError extends Error {
  constructor(entrypoint: string) {
    super(`${entrypoint} has not been implemented yet.`)
    this.name = 'PendingPipelineExportError'
  }
}

export function createPendingPipelineError(entrypoint: string): PendingPipelineExportError {
  return new PendingPipelineExportError(entrypoint)
}

export {
  createAgentStreamReporter,
  emitDogfoodJob,
  emitDogfoodRun,
  type DogfoodJobDescriptor,
  type DogfoodJobProgressEvent,
  type DogfoodJobStatus,
  type DogfoodOutputProgressEvent,
  type DogfoodProgressEvent,
  type DogfoodRunProgressEvent,
} from './dogfood-progress.ts'
