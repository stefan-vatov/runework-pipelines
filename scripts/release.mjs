#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  })

  if (result.status === 0) {
    return result
  }

  const detail = result.stderr || result.stdout || `${command} ${args.join(' ')} failed`
  throw new Error(detail.trim())
}

function packageVersion() {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  )

  return manifest.version
}

function latestTag() {
  const result = spawnSync(
    'git',
    ['describe', '--tags', '--abbrev=0'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )

  if (result.status !== 0) {
    return undefined
  }

  return result.stdout.trim() || undefined
}

function commitSubjects(range) {
  const args = ['log', '--format=%s']
  if (range) {
    args.push(range)
  }

  return run('git', args)
    .stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`)
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`
}

function detectBump(subjects) {
  if (subjects.some((subject) => /BREAKING CHANGE|^[a-z]+(\(.+\))?!:/.test(subject))) {
    return 'major'
  }

  if (subjects.some((subject) => /^feat(\(.+\))?:/.test(subject))) {
    return 'minor'
  }

  return 'patch'
}

function bumpVersion(version, bump) {
  if (bump === 'major') {
    return { major: version.major + 1, minor: 0, patch: 0 }
  }

  if (bump === 'minor') {
    return { major: version.major, minor: version.minor + 1, patch: 0 }
  }

  return { major: version.major, minor: version.minor, patch: version.patch + 1 }
}

function headHasTag(tag) {
  const result = spawnSync(
    'git',
    ['tag', '--points-at', 'HEAD'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'failed to inspect HEAD tags')
  }

  return result.stdout.split('\n').map((line) => line.trim()).includes(tag)
}

const currentVersion = packageVersion()
const currentTag = `v${currentVersion}`
const previousTag = latestTag()

if (previousTag === undefined) {
  run('git', ['tag', currentTag])
  console.log(`Tagged initial release ${currentTag}`)
  process.exit(0)
}

if (headHasTag(currentTag)) {
  console.log(`HEAD already tagged with ${currentTag}; nothing to do.`)
  process.exit(0)
}

const subjects = commitSubjects(`${previousTag}..HEAD`)
if (subjects.length === 0) {
  console.log(`No commits since ${previousTag}; nothing to release.`)
  process.exit(0)
}

const bump = detectBump(subjects)
const nextVersion = formatVersion(bumpVersion(parseVersion(currentVersion), bump))

run(npmCommand, ['version', nextVersion, '--no-git-tag-version'])
run('git', ['add', 'package.json', 'package-lock.json'])
run('git', ['commit', '-m', `chore(release): publish v${nextVersion}`])
run('git', ['tag', `v${nextVersion}`])

console.log(`Released v${nextVersion}`)
