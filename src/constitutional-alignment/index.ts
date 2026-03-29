import { defineWorkflowPipeline } from 'runework/pipelines'

const constitutionalAlignmentPipeline = defineWorkflowPipeline({
  version: 1,
  async run() {
    throw new Error('runework-pipelines/constitutional-alignment has not been implemented yet.')
  },
})

export default constitutionalAlignmentPipeline
