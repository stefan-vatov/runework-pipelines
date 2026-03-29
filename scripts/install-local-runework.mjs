#!/usr/bin/env node
import { spawn } from 'node:child_process'

import { createLocalRuneworkInstallPlan } from '../src/bootstrap.ts'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    })

    child.on('exit', (code) => {
      resolve(code ?? 1)
    })
  })
}

function normalizeCommand(command) {
  if (command === 'npm') {
    return npmCommand
  }

  return command
}

const plan = createLocalRuneworkInstallPlan(process.argv.slice(2))

const installCode = await run(
  npmCommand,
  ['install', '--no-save', plan.installSpec],
  process.cwd(),
)

if (installCode !== 0) {
  process.exit(installCode)
}

if (plan.command.length === 0) {
  process.exit(0)
}

const [command, ...args] = plan.command
process.exit(await run(normalizeCommand(command), args, process.cwd()))
