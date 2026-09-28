import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { applyNetworkRetry, retryProviderIds } from '../../electron/agent-network-retry'
import { applyAgentLaunchProfile } from '../../electron/agent-launch-profile'
import { autoCompactArgs } from '../../src/shared/auto-compact'
import { parseNetworkRetry } from '../../src/shared/network-retry'

describe('per-Agent network retries', () => {
  it('inherits without modifying args or environments by default', () => {
    for (const kind of ['codex', 'claude', 'deepseek'] as const) {
      expect(applyNetworkRetry(kind, ['resume', 'native'], undefined)).toEqual({ args: ['resume', 'native'], environment: {} })
    }
    expect(parseNetworkRetry({})).toBeUndefined()
  })
  it.each([-1, 101, 1.5, NaN, Infinity, '5'])('rejects invalid Codex retries %s', (value) => {
    expect(() => parseNetworkRetry({ codexStreamRetries: value })).toThrow()
  })
  it('allows zero, validates watchdog and limits ordinary Claude retries', () => {
    expect(parseNetworkRetry({ codexStreamRetries: 0 })).toEqual({ codexStreamRetries: 0 })
    expect(() => parseNetworkRetry({ claudeRetryWatchdog: 'true' })).toThrow()
    expect(() => parseNetworkRetry({ claudeRequestRetries: 16 })).toThrow()
    expect(parseNetworkRetry({ claudeRequestRetries: 300, claudeRetryWatchdog: true })).toEqual({ claudeRequestRetries: 300, claudeRetryWatchdog: true })
    expect(() => parseNetworkRetry({ claudeRequestRetries: 1001, claudeRetryWatchdog: true })).toThrow()
  })
  it('sets only Claude retry variables and preserves arguments', () => {
    expect(applyNetworkRetry('claude', ['--resume', 'native'], { claudeRequestRetries: 0, claudeRetryWatchdog: false })).toEqual({
      args: ['--resume', 'native'], environment: { CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_RETRY_WATCHDOG: '0' },
    })
    expect(applyNetworkRetry('claude', [], { claudeRequestRetries: 12 }).environment).toEqual({ CLAUDE_CODE_MAX_RETRIES: '12' })
  })
  it('keeps CLI provider overrides and resume scope intact', () => {
    const args = ['-c', 'model_provider="team-gateway"', 'resume', 'native', '--no-alt-screen']
    const retry = applyNetworkRetry('codex', args, { codexStreamRetries: 50, codexRequestRetries: 0 })
    expect(retry.args).toEqual(['-c', 'model_provider="team-gateway"', '-c', 'model_providers.team-gateway.stream_max_retries=50', '-c', 'model_providers.team-gateway.request_max_retries=0', 'resume', 'native', '--no-alt-screen'])
    expect(args).toHaveLength(5)
    expect(retry.environment).toEqual({})
  })
  it('honors named profiles and last explicit provider', () => {
    const config = 'model_provider="default"\n[profiles.work]\nmodel_provider="work-provider"'
    expect(retryProviderIds(config, ['--profile', 'work'])).toEqual(['work-provider'])
    expect(retryProviderIds(config, ['--profile=work', '-c', 'model_provider=a', '--config=model_provider=b'])).toEqual(['b'])
  })
  it('keeps builtin providers launchable when their reserved tables cannot be overridden', () => {
    expect(applyNetworkRetry('codex', [], { codexStreamRetries: 10 })).toEqual({ args: [], environment: {} })
    expect(applyNetworkRetry('codex', [], {})).toEqual({ args: [], environment: {} })
  })

  it('does not fail a custom OpenAI-compatible profile with retries and compaction', () => {
    const profile = { profileId: 'profile-1', source: 'custom' as const, baseUrl: 'https://gateway.example/v1', apiKey: 'secret', model: 'model-x', extraArgs: [] }
    const configured = applyAgentLaunchProfile('codex', ['resume', 'native'], profile, { id: 'openai', configurable: false })
    const retry = applyNetworkRetry('codex', configured.args, { codexStreamRetries: 100, codexRequestRetries: 100 })
    const args = autoCompactArgs('codex', retry.args, 500_000)
    expect(args).toContain('model_provider=agent-tui-manager')
    expect(args).toContain('model_providers.agent-tui-manager.stream_max_retries=100')
    expect(args).toContain('model_providers.agent-tui-manager.request_max_retries=100')
    expect(args).toContain('model_auto_compact_token_limit=500000')
    expect(args.join(' ')).not.toContain('model_providers."openai"')
    expect(args.indexOf('model_auto_compact_token_limit=500000')).toBeLessThan(args.indexOf('resume'))
    expect(retry.environment).toEqual({})
  })
  it('rejects dotted provider IDs rather than creating a different provider table', () => {
    expect(() => applyNetworkRetry('codex', ['-c', 'model_provider="team.gateway"'], { codexStreamRetries: 100 }))
      .toThrow('包含点号')
  })

  it.skipIf(!process.env.CODEX_RETRY_TEST_EXE)('loads generated retry arguments with the actual Codex parser', () => {
    const configured = applyAgentLaunchProfile('codex', ['-c', 'model_providers.retry-fixture.name="Retry fixture"'], {
      profileId: 'fixture', source: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-only', model: 'fixture', extraArgs: [],
    }, { id: 'retry-fixture', configurable: true })
    for (const settings of [{ codexStreamRetries: 100 }, { codexRequestRetries: 100 }, { codexStreamRetries: 100, codexRequestRetries: 100 }]) {
      const retry = applyNetworkRetry('codex', configured.args, settings)
      const result = spawnSync(process.env.CODEX_RETRY_TEST_EXE!, [...autoCompactArgs('codex', retry.args, 500_000), 'features', 'list'], {
        encoding: 'utf8', timeout: 15000, env: { ...process.env, ...configured.environment },
      })
      expect(result.stderr).not.toContain('provider name must not be empty')
      expect(result.status, result.stderr).toBe(0)
    }
  })

  it.skipIf(!process.env.CODEX_RETRY_TEST_CMD)('loads retry overrides through the Windows PTY and npm launcher', async () => {
    const pty = await import('node-pty')
    const configured = applyAgentLaunchProfile('codex', ['-c', 'model_providers.retry-fixture.name="Retry fixture"'], {
      profileId: 'fixture', source: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-only', extraArgs: [],
    }, { id: 'retry-fixture', configurable: true })
    const retry = applyNetworkRetry('codex', configured.args, { codexStreamRetries: 100, codexRequestRetries: 100 })
    const result = await new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
      const terminal = pty.spawn(process.env.CODEX_RETRY_TEST_CMD!, [...autoCompactArgs('codex', retry.args, 500_000), 'features', 'list'], {
        cols: 120, rows: 30, cwd: process.cwd(), env: { ...process.env, ...configured.environment }, useConptyDll: true,
      })
      let output = ''
      const timer = setTimeout(() => { terminal.kill(); reject(new Error('Codex PTY probe timed out')) }, 10000)
      terminal.onData(data => { output = (output + data).slice(-20000) })
      terminal.onExit(event => { clearTimeout(timer); resolve({ exitCode: event.exitCode, output }) })
    })
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).not.toContain('provider name must not be empty')
  }, 15000)
  it.each(['custom', 'ccswitch'] as const)('preserves %s provider A/B/C switches with retries enabled', (source) => {
    for (const id of ['A', 'B', 'C']) {
      const profile = { profileId: id, source, baseUrl: `https://${id.toLowerCase()}.example/v1`, apiKey: `key-${id}`, model: `model-${id}`, extraArgs: [] }
      for (const kind of ['codex', 'claude'] as const) {
        const configured = applyAgentLaunchProfile(kind, kind === 'codex' ? ['resume', 'native'] : ['--resume', 'native'], profile, { id: 'gateway', configurable: true })
        const snapshot = structuredClone(configured)
        const retry = applyNetworkRetry(kind, configured.args, { codexStreamRetries: 20, claudeRequestRetries: 12 })
        expect(configured).toEqual(snapshot)
        expect(retry.args.filter((arg) => !arg.includes('stream_max_retries'))).toEqual(kind === 'claude' ? configured.args : expect.arrayContaining(configured.args))
        const combined = { ...configured.environment, ...retry.environment }
        expect(combined).toMatchObject(configured.environment)
        expect(combined[kind === 'claude' ? 'ANTHROPIC_AUTH_TOKEN' : 'AGENT_TUI_MANAGER_CODEX_API_KEY']).toBe(`key-${id}`)
        expect(retry.args).toContain(`model-${id}`)
        expect(JSON.stringify(retry.args)).not.toContain(`key-${id}`)
      }
    }
  })
})
