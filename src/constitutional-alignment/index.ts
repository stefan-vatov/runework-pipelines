import { defineWorkflowPipeline } from 'runework/pipelines'

import { createPendingPipelineError } from '../lib/index.ts'

const constitutionalAlignmentPipeline = defineWorkflowPipeline({
  version: 1,
  async run() {
    throw createPendingPipelineError('runework-pipelines/constitutional-alignment')
  },
})

export default constitutionalAlignmentPipeline
