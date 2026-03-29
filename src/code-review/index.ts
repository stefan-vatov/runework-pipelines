import { defineWorkflowPipeline } from 'runework/pipelines'

import { createPendingPipelineError } from '../lib/index.ts'

const codeReviewPipeline = defineWorkflowPipeline({
  version: 1,
  async run() {
    throw createPendingPipelineError('runework-pipelines/code-review')
  },
})

export default codeReviewPipeline
