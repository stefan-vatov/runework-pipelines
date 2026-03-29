import { resolve } from 'node:path'

export type LocalRuneworkInstallPlan = {
  runeworkPath: string
  installSpec: string
  command: string[]
}

export function defaultLocalRuneworkPath(cwd = process.cwd()): string {
  return resolve(cwd, '..', 'runework', 'packages', 'runework')
}

export function toLocalRuneworkInstallSpec(runeworkPath: string): string {
  return `runework@file:${runeworkPath}`
}

export function createLocalRuneworkInstallPlan(
  argv: string[],
  cwd = process.cwd(),
): LocalRuneworkInstallPlan {
  let explicitPath: string | undefined
  let command: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--') {
      command = argv.slice(index + 1)
      break
    }

    if (arg === '--runework-path' && argv[index + 1]) {
      explicitPath = argv[index + 1]
      index += 1
      continue
    }

    command = argv.slice(index)
    break
  }

  const runeworkPath = resolve(cwd, explicitPath ?? defaultLocalRuneworkPath(cwd))

  return {
    runeworkPath,
    installSpec: toLocalRuneworkInstallSpec(runeworkPath),
    command,
  }
}
