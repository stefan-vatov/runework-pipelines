#!/usr/bin/env node
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const tscEntrypoint = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')

rmSync(join(repoRoot, 'dist'), { recursive: true, force: true })

const result = spawnSync(
  process.execPath,
  [tscEntrypoint, '-b', join(repoRoot, 'tsconfig.build.json'), '--force'],
  { stdio: 'inherit' },
)

process.exit(result.status ?? 1)
