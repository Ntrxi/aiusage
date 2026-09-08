import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile } from 'svelte/compiler'

const source = readFileSync(new URL('../src/routes/settings/+page.svelte', import.meta.url), 'utf8')

describe('write-only credential settings', () => {
  it('keeps stored secrets out of the form and submits replacements by field name', () => {
    expect(() => compile(source, { generate: false })).not.toThrow()
    expect(source).not.toMatch(/fetchCredential\(|credentialKeys|credentialRef|data\.value/)
    expect(source).toContain('applyCredentialStatus(cfg.credentialStatus ?? {})')
    expect(source).toContain('payload.syncCredentials = credentials')
    expect(source).toContain('credentials.githubToken = ghToken')
    expect(source).toContain('credentials.s3AccessKeyId = s3AkidValue')
    expect(source).toContain('credentials.s3SecretAccessKey')
  })

  it('only reveals typed replacements, and clears them after saving', () => {
    expect(source).toContain('function toggleGhToken() { ghTokenVisible = !ghTokenVisible }')
    expect(source).toContain('disabled={!ghToken}')
    expect(source).toContain('disabled={!s3AkidValue}')
    expect(source).toContain('disabled={!s3SakValue}')
    expect(source).toContain("ghTokenIsSet = true; ghToken = ''; ghTokenVisible = false")
    expect(source).toContain("s3AkidIsSet = true; s3AkidValue = ''; s3AkidVisible = false")
    expect(source).toContain("s3SakIsSet  = true; s3SakValue  = ''; s3SakVisible  = false")
  })
})
