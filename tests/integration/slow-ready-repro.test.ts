import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { SessionHostManager } from '../../electron/session-host-manager'

it('旧 5 秒期限仍可复现慢启动失败，并明确报告启动阶段', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'atm-slow-ready-'))
  const manager = new SessionHostManager({ runtimeDir, hostEntry: resolve('tests/fixtures/slow-ready-host.cjs'), startupTimeoutMs: 5000 })
  const started = Date.now()
  await expect(manager.start({ agentKind: 'generic', executable: process.execPath, args: [], cwd: runtimeDir, cols: 80, rows: 24 })).rejects.toThrow('Agent 启动超时（阶段：ready')
  expect(Date.now() - started).toBeGreaterThanOrEqual(5000)
}, 15000)

it('回归：默认启动期限允许慢 Host 就绪，运行时超时仍独立生效', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'atm-slow-ready-control-'))
  const phases: string[] = []
  const manager = new SessionHostManager({ runtimeDir, hostEntry: resolve('tests/fixtures/slow-ready-host.cjs'), timeoutMs: 100, onStartupProgress: progress => { phases.push(progress.phase) } })
  const handle = await manager.start({ agentKind: 'generic', executable: process.execPath, args: [], cwd: runtimeDir, cols: 80, rows: 24 })
  try {
    expect(await handle.ping(1000)).toBe('managed')
    await expect(handle.nextEvent(50)).rejects.toThrow('Timed out waiting for host event')
    expect(phases).toEqual(['spawn', 'connect', 'configure', 'ready', 'persist', 'complete'])
  }
  finally { handle.disconnect() }
}, 15000)
