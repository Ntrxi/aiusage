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

const siteVersionFiles = [
  {
    file: 'packages/site/src/routes/docs/+page.svelte',
    current: `<span class="meta-tag">v${currentVersion}</span>`,
    next: `<span class="meta-tag">v${nextVersion}</span>`,
  },
  {
    file: 'packages/site/src/routes/+layout.svelte',
    current: `softwareVersion: '${currentVersion}'`,
    next: `softwareVersion: '${nextVersion}'`,
  },
]

for (const { file, current, next } of siteVersionFiles) {
  const content = readFileSync(file, 'utf8')
  if (!content.includes(current)) {
    throw new Error(`${file} does not contain the expected version ${currentVersion}`)
  }
  if (!checkOnly) writeFileSync(file, content.replace(current, next))
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
  let updated = `${before}${marker}${separator}## [${nextVersion}] - ${date}\n\n${releaseBody}${separator}${after}`
  const compareLink = `[${nextVersion}]: https://github.com/juliantanx/aiusage/compare/v${currentVersion}...v${nextVersion}`
  if (!updated.includes(compareLink)) {
    const firstCompareLink = updated.search(/^\[\d+\.\d+\.\d+\]:/m)
    if (firstCompareLink === -1) throw new Error(`${file} has no compare-link section`)
    updated = `${updated.slice(0, firstCompareLink)}${compareLink}\n${updated.slice(firstCompareLink)}`
  }
  if (!checkOnly) writeFileSync(file, updated)
}

promoteUnreleased('CHANGELOG.md', '## [Unreleased]', description)
promoteUnreleased('CHANGELOG.zh-CN.md', '## [未发布]')

process.stdout.write(`${nextVersion}\n`)
