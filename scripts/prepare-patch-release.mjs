import { readFileSync, writeFileSync } from 'node:fs'

const packageFiles = [
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/site/package.json',
  'packages/web/package.json',
  'packages/widget/package.json',
]

const checkOnly = process.argv.includes('--check')
const description = (process.env.DESCRIPTION ?? '').trim()
const cliPackage = JSON.parse(readFileSync('packages/cli/package.json', 'utf8'))
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(cliPackage.version)
if (!match) throw new Error(`Unsupported CLI version: ${cliPackage.version}`)

const currentVersion = cliPackage.version
const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
const date = new Date().toISOString().slice(0, 10)

for (const file of packageFiles) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (pkg.version !== currentVersion) {
    throw new Error(`${file} is at ${pkg.version}, expected ${currentVersion}`)
  }
  if (!checkOnly) {
    pkg.version = nextVersion
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  }
}

function promoteUnreleased(file, marker, summary = '') {
  const changelog = readFileSync(file, 'utf8')
  const markerIndex = changelog.indexOf(marker)
  if (markerIndex === -1) throw new Error(`${file} is missing ${marker}`)
  if (changelog.includes(`## [${nextVersion}]`)) {
    throw new Error(`${file} already contains ${nextVersion}`)
  }

  const separator = '\n\n---\n\n'
  const boundary = changelog.indexOf(`${separator}## [`, markerIndex + marker.length)
  if (boundary === -1) throw new Error(`${file} has no release after ${marker}`)

  const unreleased = changelog.slice(markerIndex + marker.length, boundary).trim()
  if (!unreleased) throw new Error(`${file} has no unreleased changes to publish`)

  const releaseBody = summary ? `${summary}\n\n${unreleased}` : unreleased
  const before = changelog.slice(0, markerIndex)
  const after = changelog.slice(boundary + separator.length)
  const updated = `${before}${marker}${separator}## [${nextVersion}] - ${date}\n\n${releaseBody}${separator}${after}`
  if (!checkOnly) writeFileSync(file, updated)
}

promoteUnreleased('CHANGELOG.md', '## [Unreleased]', description)
promoteUnreleased('CHANGELOG.zh-CN.md', '## [未发布]')

process.stdout.write(`${nextVersion}\n`)
