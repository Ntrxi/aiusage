import type { Config, SyncConfig } from '../config.js'

function credentialFields(sync?: SyncConfig): Record<string, string> {
  if (sync?.backend === 'github' && sync.repo) return { githubToken: `github/${sync.repo}/token` }
  if (sync?.backend === 's3' && sync.bucket) return {
    s3AccessKeyId: `s3/${sync.bucket}/accessKeyId`,
    s3SecretAccessKey: `s3/${sync.bucket}/secretAccessKey`,
  }
  return {}
}

export function credentialStatus(config: Config, sync = config.sync): Record<string, boolean> {
  return Object.fromEntries(Object.entries(credentialFields(sync)).map(([field, key]) => [field, Boolean(config.credentials?.[key])]))
}

export function publicSyncConfig(sync?: SyncConfig): Omit<SyncConfig, 'credentialRef'> | null {
  if (!sync) return null
  const { backend, repo, bucket, prefix, endpoint, region } = sync
  return { backend, repo, bucket, prefix, endpoint, region }
}

export function setSyncCredentials(config: Config, values: Record<string, unknown>): void {
  for (const [field, key] of Object.entries(credentialFields(config.sync))) {
    const value = values[field]
    // Empty or omitted fields preserve the existing value.
    if (typeof value === 'string' && value) {
      config.credentials = { ...config.credentials, [key]: value }
    }
  }
}
