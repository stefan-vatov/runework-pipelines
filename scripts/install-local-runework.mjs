#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

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

async function linkLocalRunework(runeworkPath, cwd) {
  const nodeModulesPath = join(cwd, 'node_modules')
  const linkPath = join(nodeModulesPath, 'runework')

  await mkdir(nodeModulesPath, { recursive: true })
  await rm(linkPath, { recursive: true, force: true })
  await symlink(
    runeworkPath,
    linkPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
}

const plan = createLocalRuneworkInstallPlan(process.argv.slice(2))
await linkLocalRunework(plan.runeworkPath, process.cwd())

if (plan.command.length === 0) {
  process.exit(0)
}

const [command, ...args] = plan.command
process.exit(await run(normalizeCommand(command), args, process.cwd()))
