import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AgentConfigurationStore, type SecureConfigurationCodec } from '../../electron/agent-configuration-store'

const roots: string[] = []
const codec: SecureConfigurationCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from([...value].reverse().join(''), 'utf8'),
  decryptString: (value) => Buffer.from(value).toString('utf8').split('').reverse().join(''),
}

describe('AgentConfigurationStore', () => {
  it('retains retry-only settings without requiring encrypted provider storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retry-store-'))
    roots.push(root)
    const store = await AgentConfigurationStore.load(join(root, 'config.json'), { ...codec, isEncryptionAvailable: () => false })
    expect(await store.save({ enabled: false, source: 'local', networkRetry: { codexStreamRetries: 30 } })).toEqual({
      ...AgentConfigurationStore.localSummary(), networkRetry: { codexStreamRetries: 30 },
    })
  })
  it('keeps the independent key on retry edits and persists the selected settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-retry-store-'))
    roots.push(root)
    const path = join(root, 'config.json')
    const store = await AgentConfigurationStore.load(path, codec)
    const first = await store.save({ enabled: true, source: 'custom', apiKey: 'saved-secret', model: 'model-a', baseUrl: 'https://a.example/v1' })
    const updated = await store.save({ enabled: true, source: 'custom', model: first.model, baseUrl: first.baseUrl, networkRetry: { codexStreamRetries: 30 } }, first.profileId)
    const restored = await AgentConfigurationStore.load(path, codec)
    expect(restored.get(updated.profileId!)).toMatchObject({ apiKey: 'saved-secret', model: 'model-a', baseUrl: 'https://a.example/v1', networkRetry: { codexStreamRetries: 30 } })
    expect(updated).toMatchObject({ hasApiKey: true, networkRetry: { codexStreamRetries: 30 } })
    const cleared = await store.save({ enabled: true, source: 'custom', model: first.model, baseUrl: first.baseUrl }, first.profileId)
    expect(cleared.networkRetry).toBeUndefined()
    expect(store.get(first.profileId!)?.apiKey).toBe('saved-secret')
  })
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('persists encrypted profiles and never exposes the API key in its envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-store-'))
    roots.push(root)
    const path = join(root, 'profiles.json')
    const store = await AgentConfigurationStore.load(path, codec)
    const saved = await store.save({
      enabled: true,
      source: 'custom',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'top-secret-key',
      model: 'model-x',
      extraArgs: ['--feature'],
    })

    expect(saved).toMatchObject({ enabled: true, source: 'custom', hasApiKey: true, model: 'model-x' })
    expect(await readFile(path, 'utf8')).not.toContain('top-secret-key')
    const restored = await AgentConfigurationStore.load(path, codec)
    expect(restored.get(saved.profileId!)).toMatchObject({ apiKey: 'top-secret-key', baseUrl: 'https://gateway.example/v1' })
  })

  it('preserves a saved key when an edit leaves the key blank and can explicitly clear it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-store-'))
    roots.push(root)
    const store = await AgentConfigurationStore.load(join(root, 'profiles.json'), codec)
    const first = await store.save({ enabled: true, source: 'custom', apiKey: 'keep-me', extraArgs: [] })
    const updated = await store.save({ enabled: true, source: 'custom', model: 'new-model', extraArgs: [] }, first.profileId)
    expect(store.get(updated.profileId!)?.apiKey).toBe('keep-me')
    const cleared = await store.save({ enabled: true, source: 'custom', clearApiKey: true, extraArgs: [] }, first.profileId)
    expect(cleared.hasApiKey).toBe(false)
    expect(store.get(cleared.profileId!)).not.toHaveProperty('apiKey')
  })

  it('keeps local inheritance available when secure storage is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-store-'))
    roots.push(root)
    const unavailable = await AgentConfigurationStore.load(join(root, 'profiles.json'), {
      isEncryptionAvailable: () => false,
      encryptString: () => new Uint8Array(),
      decryptString: () => '',
    })
    await expect(unavailable.save({ enabled: true, source: 'custom', apiKey: 'secret', extraArgs: [] })).rejects.toThrow(/安全存储/)
    await expect(unavailable.save({ enabled: false, source: 'local' })).resolves.toEqual(AgentConfigurationStore.localSummary())
  })
})
