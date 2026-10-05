import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApprovalPolicyEngine } from '../../electron/approval-policy'
import { SessionController, type LlmApprovalReviewPort, type SessionHostManagerPort } from '../../electron/session-controller'
import type { HostHandle, HostRecord } from '../../electron/session-host-manager'
import type { ApprovalMode, LlmReviewConclusion } from '../../src/shared/manager-api'
import type { HostEvent } from '../../src/shared/protocol'

class ApprovalHandle implements HostHandle {
  constructor(readonly hostId = 'approval-mode-host') {}
  readonly writes: string[] = []
  readonly permissionResponses: Array<{ requestId: string; action: 'allow' | 'ask' | 'deny' }> = []
  readonly permissionReasons: Array<string | undefined> = []
  permissionHook?: 'claude' | 'codex' = 'codex'
  readonly stop = vi.fn(async (): Promise<void> => undefined)
  readonly preserveOnDisconnect = vi.fn(async () => undefined)
  readonly resumeManagement = vi.fn()
  readonly ping = vi.fn(async (): Promise<'managed'> => 'managed')
  private readonly events: Array<HostEvent | Error> = []
  private readonly waiters: Array<{ resolve: (event: HostEvent) => void; reject: (error: Error) => void }> = []

  nextEvent(): Promise<HostEvent> {
    const event = this.events.shift()
    if (event instanceof Error) return Promise.reject(event)
    return event ? Promise.resolve(event) : new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
  emit(event: HostEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(event)
    else this.events.push(event)
  }
  fail(error: Error): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.reject(error)
    else this.events.push(error)
  }
  write(data: string): void { this.writes.push(data) }
  resize(): void {}
  async replay(): Promise<string> { return '' }
  disconnect(): void {}
  respondToPermission(requestId: string, action: 'allow' | 'ask' | 'deny', reason?: string): void {
    this.permissionResponses.push({ requestId, action })
    this.permissionReasons.push(reason)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function conclusion(verdict: LlmReviewConclusion['verdict']): LlmReviewConclusion {
  return { verdict, riskScore: verdict === 'allow' ? 5 : 90, summary: `review-${verdict}`, reasons: ['fixture evidence'], hazards: [], assumptions: [], requiresHumanApproval: verdict !== 'allow', model: 'fixture-reviewer', reviewedAt: 1 }
}

const ordinaryCommand = 'git status --short'
const highRiskCommand = 'Remove-Item -LiteralPath .\\cache -Recurse -Force'
const workspace = 'B:\\work'

function fixture(kind: 'codex' | 'claude' = 'codex') {
  const handle = new ApprovalHandle()
  handle.permissionHook = kind
  const manager: SessionHostManagerPort = {
    start: vi.fn(async () => handle), reconnect: vi.fn(async () => handle),
    listLiveHosts: vi.fn(async (): Promise<HostRecord[]> => []),
    readLastExit: vi.fn(async () => undefined), updateMetadata: vi.fn(async () => undefined),
    removeArtifacts: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
  }
  const policy = new ApprovalPolicyEngine()
  const reviewer = {
    getSettings: vi.fn(() => ({ enabled: true, level: 'high' as const })),
    reviewApproval: vi.fn<LlmApprovalReviewPort['reviewApproval']>(async () => conclusion('allow')),
  }
  const activity = { approved: vi.fn(), blocked: vi.fn(), rejected: vi.fn(), reviewStarted: vi.fn(), reviewed: vi.fn(), reviewFailed: vi.fn() }
  const controller = new SessionController(manager, undefined, undefined, policy, undefined, activity, undefined, undefined, undefined, reviewer)
  const start = (recoverable = false) => controller.startSession({ displayName: 'approval fixture', agentKind: kind, workspace, executable: kind, args: [], cols: 100, rows: 30, nativeSessionId: 'fixture-native-session',
    ...(recoverable ? { recovery: { executable: kind, args: ['resume', 'fixture-native-session'] } } : {}),
  })
  const emitApproval = (requestId: string, command = highRiskCommand, overrides: Partial<Extract<HostEvent, { type: 'permission-request' }>> = {}) => handle.emit({
    type: 'permission-request', hookSource: kind, requestId, toolName: 'PowerShell', command,
    operation: command === ordinaryCommand ? 'read' : 'delete', cwd: workspace,
    toolInput: { command, cwd: workspace }, ...overrides,
  })
  const setMode = async (sessionId: string, mode: ApprovalMode) => {
    if (mode === 'unattended') await controller.setUnattendedMode(sessionId, { enabled: true, endWord: 'TEST-DONE', recoveryWord: 'continue', approvalEnterDelaySeconds: 0 })
    else await controller.setApprovalMode(sessionId, mode)
  }
  return { controller, handle, manager, policy, reviewer, activity, start, emitApproval, setMode }
}

async function drain(): Promise<void> { await vi.advanceTimersByTimeAsync(0) }

describe('controller approval modes acceptance', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  const cases = (['codex', 'claude'] as const).flatMap(kind =>
    (['manual', 'agent-review', 'rules-auto', 'unattended'] as const).flatMap(mode =>
      (['ordinary', 'high-risk'] as const).map(risk => ({ kind, mode, risk }))))

  it.each(cases)('$kind $mode handles $risk operations with the selected mode only', async ({ kind, mode, risk }) => {
    const f = fixture(kind)
    const session = await f.start()
    await f.setMode(session.sessionId, mode)
    f.emitApproval('matrix-request', risk === 'ordinary' ? ordinaryCommand : highRiskCommand)
    await drain()
    if (mode === 'unattended') await vi.advanceTimersByTimeAsync(5000)

    const expectedAction = mode === 'manual' ? undefined : mode === 'rules-auto' && risk === 'high-risk' ? 'deny' : 'allow'
    expect(f.handle.permissionResponses).toEqual(expectedAction ? [{ requestId: 'matrix-request', action: expectedAction }] : [])
    expect(f.reviewer.reviewApproval).toHaveBeenCalledTimes(mode === 'agent-review' && risk === 'high-risk' ? 1 : 0)
    expect(f.controller.listPendingApprovals()).toHaveLength(expectedAction ? 0 : 1)
    expect(f.controller.listSessions()[0]?.approvalMode).toBe(mode)
  })

  it('manual mode ignores both built-in and saved allow rules', async () => {
    const f = fixture()
    const session = await f.start()
    f.policy.addRule('git log --oneline')
    expect(f.policy.decide(ordinaryCommand).action).toBe('auto-approve')
    expect(f.policy.decide('git log --oneline').action).toBe('auto-approve')
    await f.setMode(session.sessionId, 'manual')
    f.emitApproval('built-in-allow', ordinaryCommand)
    f.emitApproval('saved-allow', 'git log --oneline', { operation: 'read' })
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.controller.listPendingApprovals().map(request => request.requestId)).toEqual(['built-in-allow', 'saved-allow'])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
  })

  it.each(['agent-review', 'rules-auto'] as const)('%s auto-approves ordinary writes and unknown tools without a model call', async mode => {
    const f = fixture()
    const session = await f.start()
    await f.setMode(session.sessionId, mode)
    f.emitApproval('ordinary-write', 'Set-Content -LiteralPath .\\notes.txt updated', { operation: 'write' })
    f.emitApproval('ordinary-build', 'npm test', { operation: 'unknown' })
    f.emitApproval('ordinary-tool', 'tool:InspectResource', { operation: 'unknown', toolName: 'InspectResource', toolInput: { resource: 'project-metadata' } })
    await drain()
    expect(f.handle.permissionResponses).toEqual([
      { requestId: 'ordinary-write', action: 'allow' },
      { requestId: 'ordinary-build', action: 'allow' },
      { requestId: 'ordinary-tool', action: 'allow' },
    ])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it.each(['allow', 'deny', 'manual', 'uncertain'] as const)('applies a high-risk reviewer %s verdict exactly once', async verdict => {
    const f = fixture()
    const session = await f.start()
    f.reviewer.reviewApproval.mockResolvedValue(conclusion(verdict))
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('verdict')
    await drain()
    expect(f.reviewer.reviewApproval).toHaveBeenCalledOnce()
    const [reviewed, reason, signal] = f.reviewer.reviewApproval.mock.calls[0]!
    expect(reviewed).toMatchObject({ command: highRiskCommand, workspace, hookCwd: workspace })
    expect(reason).toEqual(expect.any(String))
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'verdict', action: verdict === 'allow' ? 'allow' : 'deny' }])
    expect(f.controller.listPendingApprovals()).toEqual([])
    if (verdict !== 'allow') expect(f.handle.permissionReasons[0]).toContain('实质更安全的新请求')
  })

  it('rejects a failed reviewer request and reports the service failure without waiting for a human', async () => {
    const f = fixture()
    const session = await f.start()
    f.reviewer.reviewApproval.mockRejectedValue(new Error('fixture timeout'))
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('failed-review')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'failed-review', action: 'deny' }])
    expect(f.handle.permissionReasons[0]).toContain('审核不可用不代表该命令已被判定危险')
    expect(f.controller.listPendingApprovals()).toEqual([])
    expect(f.activity.reviewFailed).toHaveBeenCalledOnce()
  })

  it.each(['agent-review', 'rules-auto'] as const)('%s rejects truncated requests without consulting the reviewer', async mode => {
    const f = fixture()
    const session = await f.start()
    await f.setMode(session.sessionId, mode)
    f.emitApproval('truncated', highRiskCommand, { inputTruncated: true })
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'truncated', action: 'deny' }])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toHaveLength(0)
  })

  it.each(['codex', 'claude'] as const)('%s rejects without human handoff when the reviewer is disabled', async kind => {
    const f = fixture(kind)
    f.reviewer.getSettings.mockReturnValue({ enabled: false, level: 'high' })
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('disabled')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'disabled', action: 'deny' }])
    expect(f.handle.permissionReasons[0]).toContain('不转人工')
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it('stops safely if a rejection cannot reach its exact hook, without leaving a human approval queued', async () => {
    const f = fixture()
    Object.assign(f.handle, { respondToPermissionChecked: vi.fn(async () => false) })
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    f.emitApproval('lost-hook')
    await drain()
    expect(f.handle.stop).toHaveBeenCalledOnce()
    expect(f.handle.writes).toEqual([])
    expect(f.controller.listPendingApprovals()).toEqual([])
    expect(f.controller.listSessions()[0]).toMatchObject({ status: 'failed', userStopRequested: true })
  })

  it.each(['allow', 'deny'] as const)('a late failed %s delivery cannot stop a replacement host', async verdict => {
    const f = fixture()
    const delivery = deferred<boolean>()
    const checked = vi.fn(() => delivery.promise)
    Object.assign(f.handle, { respondToPermissionChecked: checked })
    f.reviewer.reviewApproval.mockResolvedValue(conclusion(verdict))
    const session = await f.start(true)
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('old-delivery'); await drain()
    expect(checked).toHaveBeenCalledOnce()
    await f.controller.stopSession(session.sessionId)
    const replacement = new ApprovalHandle('replacement-host')
    vi.mocked(f.manager.start).mockResolvedValueOnce(replacement)
    await f.controller.restartSession(session.sessionId)
    delivery.resolve(false); await drain()
    expect(replacement.stop).not.toHaveBeenCalled()
    expect(f.controller.listSessions()[0]).toMatchObject({ status: 'running', userStopRequested: false })
    expect(f.activity.blocked).not.toHaveBeenCalled()
  })

  it.each(['user-stop', 'manual-mode'] as const)('a late rejected delivery preserves an explicit %s', async action => {
    const f = fixture()
    const delivery = deferred<boolean>()
    Object.assign(f.handle, { respondToPermissionChecked: vi.fn(() => delivery.promise) })
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    f.emitApproval('delayed-deny'); await drain()
    if (action === 'user-stop') await f.controller.stopSession(session.sessionId)
    else await f.setMode(session.sessionId, 'manual')
    delivery.reject(new Error('synthetic response failure')); await drain()
    expect(f.handle.stop).toHaveBeenCalledTimes(action === 'user-stop' ? 1 : 0)
    expect(f.controller.listSessions()[0]?.status).toBe(action === 'user-stop' ? 'stopped' : 'needs_approval')
    expect(f.activity.blocked).not.toHaveBeenCalled()
  })

  it.each(['user-stop', 'restart'] as const)('a delayed automatic stop receipt cannot overwrite a later %s', async action => {
    const f = fixture()
    const stopping = deferred<void>()
    f.handle.stop.mockReturnValueOnce(stopping.promise)
    Object.assign(f.handle, { respondToPermissionChecked: vi.fn(async () => false) })
    const session = await f.start(true)
    await f.setMode(session.sessionId, 'rules-auto')
    f.emitApproval('failed-delivery'); await drain()
    expect(f.handle.stop).toHaveBeenCalledOnce()
    const replacement = new ApprovalHandle('replacement-host')
    if (action === 'user-stop') await f.controller.stopSession(session.sessionId)
    else {
      vi.mocked(f.manager.start).mockResolvedValueOnce(replacement)
      await f.controller.restartSession(session.sessionId)
    }
    stopping.resolve(); await drain()
    expect(replacement.stop).not.toHaveBeenCalled()
    expect(f.controller.listSessions()[0]?.status).toBe(action === 'user-stop' ? 'stopped' : 'running')
  })

  it.each(['manual', 'rules-auto', 'agent-review'] as const)('%s handles exhausted terminal approval retries without changing manual behavior', async mode => {
    const f = fixture()
    f.handle.permissionHook = undefined
    const session = await f.start()
    await f.setMode(session.sessionId, mode)
    f.handle.emit({ type: 'output', data: 'Would you like to run the following command?\r\n$ git status --short\r\n1. Yes, proceed\r\n2. No' })
    await drain()
    if (mode === 'manual') await f.controller.approveSession(session.sessionId)
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.controller.listPendingApprovals()).toHaveLength(mode === 'manual' ? 1 : 0)
    expect(f.handle.stop).toHaveBeenCalledTimes(mode === 'manual' ? 0 : 1)
    expect(f.controller.listSessions()[0]?.status).toBe(mode === 'manual' ? 'needs_approval' : 'failed')
    if (mode !== 'manual') expect(f.activity.blocked).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('重试耗尽'))
  })

  it.each(['still-pending', 'closed', 'new-command'] as const)('checks the exact terminal approval after a rejection: %s', async outcome => {
    const f = fixture()
    f.handle.permissionHook = undefined
    const prompt = (command: string) => 'Would you like to run the following command?\r\n$ ' + command + '\r\n1. Yes, proceed\r\n2. No'
    vi.spyOn(f.handle, 'replay').mockResolvedValue(outcome === 'closed' ? 'Codex\r\n›\r\n' : prompt(outcome === 'new-command' ? ordinaryCommand : highRiskCommand))
    const session = await f.start()
    await f.setMode(session.sessionId, 'rules-auto')
    f.handle.emit({ type: 'output', data: prompt(highRiskCommand) }); await drain()
    expect(f.handle.writes).toEqual(['\x1b'])
    await vi.advanceTimersByTimeAsync(1100)
    expect(f.handle.stop).toHaveBeenCalledTimes(outcome === 'still-pending' ? 1 : 0)
    expect(f.controller.listPendingApprovals()).toEqual([])
    if (outcome === 'still-pending') expect(f.activity.blocked).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('自动拒绝按键已发送'))
  })

  it.each([true, false])('checks a Claude denial and an alias arriving during its ACK (alias delivered: %s)', async aliasDelivered => {
    const f = fixture('claude')
    const primary = deferred<boolean>()
    const checked = vi.fn((id: string) => id === 'primary' ? primary.promise : Promise.resolve(aliasDelivered))
    Object.assign(f.handle, { respondToPermissionChecked: checked })
    f.reviewer.reviewApproval.mockResolvedValue(conclusion('deny'))
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('primary', highRiskCommand, { toolUseId: 'shared-tool' }); await drain()
    f.emitApproval('child-alias', highRiskCommand, { toolUseId: 'shared-tool', agentId: 'child-agent' }); await drain()
    expect(checked).toHaveBeenCalledOnce()
    primary.resolve(true); await drain()
    expect(checked.mock.calls.map(([id]) => id)).toEqual(['primary', 'child-alias'])
    expect(checked).toHaveBeenCalledWith('child-alias', 'deny', expect.stringContaining('实质更安全的新请求'))
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.handle.stop).toHaveBeenCalledTimes(aliasDelivered ? 0 : 1)
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it.each(['manual', 'rules-auto'] as const)('cancels a pending review when switching to %s and ignores a late allow', async mode => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('old-review')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    expect(signal.aborted).toBe(false)
    await f.setMode(session.sessionId, mode)
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual(mode === 'rules-auto' ? [{ requestId: 'old-review', action: 'deny' }] : [])
    expect(f.reviewer.reviewApproval).toHaveBeenCalledOnce()
  })

  it('changes the effective mode and cancels reviews before a deferred metadata write finishes', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('old-review')
    await drain()
    const persisted = deferred<void>()
    vi.mocked(f.manager.updateMetadata).mockReturnValueOnce(persisted.promise)
    const switching = f.controller.setApprovalMode(session.sessionId, 'manual')
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('manual')
    expect(f.reviewer.reviewApproval.mock.calls[0]![2]!.aborted).toBe(true)
    f.emitApproval('arrived-during-save', ordinaryCommand)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.reviewer.reviewApproval).toHaveBeenCalledOnce()
    persisted.resolve()
    await switching
    expect(f.controller.listPendingApprovals().map(request => request.requestId)).toEqual(['old-review', 'arrived-during-save'])
  })

  it('falls back to manual if enabling an automatic mode cannot be persisted', async () => {
    const f = fixture()
    const session = await f.start()
    vi.mocked(f.manager.updateMetadata).mockRejectedValueOnce(new Error('fixture persistence failure'))
    await expect(f.controller.setApprovalMode(session.sessionId, 'rules-auto')).rejects.toThrow('fixture persistence failure')
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('manual')
    f.emitApproval('after-failed-save', ordinaryCommand)
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer mode when an older metadata write fails', async () => {
    const f = fixture()
    const session = await f.start()
    const firstSave = deferred<void>()
    vi.mocked(f.manager.updateMetadata).mockReturnValueOnce(firstSave.promise)
    const firstSwitch = f.controller.setApprovalMode(session.sessionId, 'rules-auto')
    const firstOutcome = expect(firstSwitch).rejects.toThrow('old metadata failure')
    await drain()
    const secondSwitch = f.controller.setApprovalMode(session.sessionId, 'agent-review')
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('agent-review')
    firstSave.reject(new Error('old metadata failure'))
    await firstOutcome
    await secondSwitch
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('agent-review')
  })

  it('does not re-enable unattended after a newer mode supersedes its pending save', async () => {
    const f = fixture()
    const session = await f.start()
    const firstSave = deferred<void>()
    vi.mocked(f.manager.updateMetadata).mockReturnValueOnce(firstSave.promise)
    const enabling = f.controller.setUnattendedMode(session.sessionId, { enabled: true, endWord: 'TEST-DONE', recoveryWord: 'continue' })
    await drain()
    const switching = f.controller.setApprovalMode(session.sessionId, 'rules-auto')
    firstSave.resolve()
    await enabling
    await switching
    expect(f.controller.listSessions()[0]?.approvalMode).toBe('rules-auto')
    expect(f.controller.listSessions()[0]?.unattended?.enabled).not.toBe(true)
    f.emitApproval('after-unattended-race')
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'after-unattended-race', action: 'deny' }])
    expect(f.reviewer.reviewApproval).not.toHaveBeenCalled()
  })

  it.each(['stop', 'ctrl-c', 'escape'] as const)('%s cancels a pending review and ignores its late verdict', async action => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('interrupted')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    if (action === 'stop') await f.controller.stopSession(session.sessionId)
    else f.controller.write(session.sessionId, action === 'ctrl-c' ? '\x03' : '\x1b')
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    if (action === 'stop') expect(f.handle.stop).toHaveBeenCalledOnce()
  })

  it('replaces a pending review when a same-ID request carries refined command and tool arguments', async () => {
    const f = fixture()
    const first = deferred<LlmReviewConclusion>()
    const second = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('refined')
    await drain()
    const refinedCommand = 'Remove-Item -LiteralPath .\\logs -Recurse -Force'
    f.emitApproval('refined', refinedCommand)
    await drain()
    expect(f.reviewer.reviewApproval).toHaveBeenCalledTimes(2)
    const [oldCall, newCall] = f.reviewer.reviewApproval.mock.calls
    expect(oldCall![2]!.aborted).toBe(true)
    expect(newCall![2]!.aborted).toBe(false)
    expect(newCall![0]).toMatchObject({ command: refinedCommand, toolInput: { command: refinedCommand } })
    first.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    second.resolve(conclusion('deny'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'refined', action: 'deny' }])
  })

  it('does not duplicate a pending review when an unchanged same-ID hook is re-emitted', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('repaint')
    await drain()
    f.emitApproval('repaint')
    await drain()
    expect(f.reviewer.reviewApproval).toHaveBeenCalledOnce()
    expect(f.controller.listPendingApprovals()[0]?.llmReviewStatus).toBe('pending')
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'repaint', action: 'allow' }])
  })

  it('manual approval wins a race with a late reviewer denial without a duplicate response', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('human-choice')
    await drain()
    await f.controller.approveRequest('human-choice')
    expect(f.reviewer.reviewApproval.mock.calls[0]![2]!.aborted).toBe(true)
    pending.resolve(conclusion('deny'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'human-choice', action: 'allow' }])
  })

  it('cancels an abandoned hook request rather than leaving its reviewer running', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('closed-hook')
    await drain()
    f.handle.emit({ type: 'permission-hook-closed', hookSource: 'codex', requestId: 'closed-hook' })
    await drain()
    expect(f.reviewer.reviewApproval.mock.calls[0]![2]!.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it.each([0, 1])('cancels a pending reviewer when its host exits with code %i', async exitCode => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('host-exit')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    f.handle.emit({ type: 'exit', exitCode })
    await drain()
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    expect(f.controller.listPendingApprovals()).toEqual([])
  })

  it('cancels a pending reviewer when the host connection is lost without an exit receipt', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('lost-host')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    f.handle.fail(new Error('fixture socket closed'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
  })

  it('cancels reviewers when preserving sessions and disconnecting the manager', async () => {
    const f = fixture()
    const pending = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValue(pending.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('preserved-session')
    await drain()
    const signal = f.reviewer.reviewApproval.mock.calls[0]![2]!
    expect(await f.controller.preserveAllSessions()).toBe(1)
    expect(signal.aborted).toBe(true)
    pending.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
  })

  it('invalidates a review when the policy or reviewer configuration is refreshed', async () => {
    const f = fixture()
    const first = deferred<LlmReviewConclusion>()
    const second = deferred<LlmReviewConclusion>()
    f.reviewer.reviewApproval.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const session = await f.start()
    await f.setMode(session.sessionId, 'agent-review')
    f.emitApproval('config-change')
    await drain()
    await f.controller.refreshApprovalPolicy()
    expect(f.reviewer.reviewApproval).toHaveBeenCalledTimes(2)
    expect(f.reviewer.reviewApproval.mock.calls[0]![2]!.aborted).toBe(true)
    first.resolve(conclusion('allow'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([])
    second.resolve(conclusion('deny'))
    await drain()
    expect(f.handle.permissionResponses).toEqual([{ requestId: 'config-change', action: 'deny' }])
  })
})
