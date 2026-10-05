import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NativeSessionActivityMonitor, parseNativeActivity, type NativeActivityEvent } from '../../electron/native-session-activity'
import { sessionDisplayStatus, parseSessionDisplayStatus } from '../../src/shared/session-state'
import type { SessionSummary } from '../../src/shared/manager-api'

function codexQuestion(timestamp: number, id: string, async = false, count = 1) {
  return { timestamp, type: 'response_item', payload: {
    type: 'function_call', name: async ? 'functions.request_user_input_async' : 'functions.request_user_input', call_id: id,
    arguments: JSON.stringify({ questions: Array.from({ length: count }, (_, index) => async
      ? { title: 'Which option?', options: ['first', 'second'] }
      : { id: 'choice-' + index, question: 'Which option?', options: [] }) }),
  } }
}

function codexResult(timestamp: number, id: string, output: unknown = { answers: { choice: 'first' } }) {
  return { timestamp, type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(output) } }
}

async function questionMonitor(kind: 'codex' | 'claude', rows: unknown[], check: (fixture: {
  monitor: NativeSessionActivityMonitor; events: NativeActivityEvent[]; path: string; session: SessionSummary
  append: (...rows: unknown[]) => Promise<void>
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'atm-question-'))
  const path = join(root, kind === 'codex' ? 'rollout-questions-native-one.jsonl' : 'native-one.jsonl')
  const session = { sessionId: 'manager-one', nativeSessionId: 'native-one', agentKind: kind,
    status: 'running', activitySince: 200 } as SessionSummary
  const events: NativeActivityEvent[] = []
  const monitor = new NativeSessionActivityMonitor(() => [session], (_session, event) => {
    events.push(event)
    session.activityUpdatedAt = Math.max(session.activityUpdatedAt ?? 0, event.timestamp)
  }, { codex: root, claude: root })
  try {
    await writeFile(path, rows.map(row => JSON.stringify(row) + '\n').join(''))
    await check({ monitor, events, path, session, append: async (...rows) => { await appendFile(path, rows.map(row => JSON.stringify(row) + '\n').join('')) } })
  } finally {
    monitor.stop()
    await rm(root, { recursive: true, force: true })
  }
}

describe('native task activity', () => {
  it('treats a failed task_complete as an error so overnight recovery uses backoff', () => {
    expect(parseNativeActivity('codex', { timestamp: 1000, type: 'event_msg',
      payload: { type: 'task_complete', error: { message: 'retries exhausted' } } }, 'native-one'))
      .toEqual({ timestamp: 1000, activity: 'error', error: 'retries exhausted' })
  })
  it('extracts assistant output without mistaking user prompts or commentary for completion', () => {
    const event = { timestamp: 1000, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'TASK-DONE' } }
    expect(parseNativeActivity('codex', event, 'native-one')?.assistantMessage?.text).toBe('TASK-DONE')
    expect(parseNativeActivity('codex', { ...event, payload: { type: 'user_message', message: 'continue TASK-DONE' } }, 'native-one')?.assistantMessage).toBeUndefined()
    expect(parseNativeActivity('codex', { timestamp: 1000, type: 'response_item',
      payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'TASK-DONE' }] } }, 'native-one'))
      .toEqual({ activity: 'running', timestamp: 1000 })
  })
  it.each([
    { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Synthetic progress' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec', call_id: 'call-1', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'functions.exec', call_id: 'call-2', input: 'synthetic' } },
  ])('recognizes structured Codex progress without exposing text as an answer: %j', (record) => {
    expect(parseNativeActivity('codex', { timestamp: 1000, ...record }, 'native-one')).toEqual({ activity: 'running', timestamp: 1000 })
    expect(parseNativeActivity('codex', { timestamp: 1000, ...record, agentId: 'child' }, 'native-one')).toBeUndefined()
  })
  it('only exposes real parent user messages as delivery receipts', () => {
    const codex = { timestamp: 1000, type: 'event_msg', payload: { type: 'user_message', message: 'continue' } }
    expect(parseNativeActivity('codex', codex, 'native-one')?.userMessage).toEqual({ text: 'continue', timestamp: 1000 })
    const claude = { timestamp: 1000, type: 'user', message: { content: [{ type: 'text', text: 'continue' }] } }
    expect(parseNativeActivity('claude', claude, 'native-one')?.userMessage?.text).toBe('continue')
    expect(parseNativeActivity('claude', { ...claude, isSidechain: true }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('claude', { ...claude, isMeta: true }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('claude', { ...claude, message: { content: [{ type: 'tool_result', content: 'continue' }] } }, 'native-one')?.userMessage).toBeUndefined()
  })
  it.each([
    ['task_started', 'running'], ['task_complete', 'completed'], ['turn_aborted', 'idle'],
  ])('maps Codex %s to %s', (type, activity) => {
    expect(parseNativeActivity('codex', {
      timestamp: 1000, type: 'event_msg', payload: { type },
    }, 'native-one')).toEqual({ timestamp: 1000, activity })
  })

  it('distinguishes errors from retries and ignores subagent or foreign events', () => {
    const event = { timestamp: 1000, type: 'event_msg', payload: { type: 'error', message: 'failed' } }
    expect(parseNativeActivity('codex', event, 'native-one')?.activity).toBe('error')
    expect(parseNativeActivity('codex', { ...event, payload: { ...event.payload, will_retry: true } }, 'native-one')?.activity).toBe('running')
    expect(parseNativeActivity('claude', { timestamp: 1000, type: 'assistant', isSidechain: true }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('codex', { ...event, sessionId: 'native-two' }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('codex', { ...event, timestamp: 'invalid' }, 'native-one')).toBeUndefined()
  })

  it('recognizes Claude completion and API errors', () => {
    expect(parseNativeActivity('claude', {
      timestamp: 1000, type: 'assistant', message: { stop_reason: 'end_turn' },
    }, 'native-one')?.activity).toBe('completed')
    expect(parseNativeActivity('claude', {
      timestamp: 1001, type: 'assistant', isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'service unavailable' }] },
    }, 'native-one')).toEqual({ timestamp: 1001, activity: 'error', error: 'service unavailable' })
  })

  it('projects five display states without changing lifecycle or approvals', () => {
    expect(sessionDisplayStatus({ status: 'running', activity: 'idle' })).toBe('idle')
    expect(sessionDisplayStatus({ status: 'running', activity: 'completed' })).toBe('idle')
    expect(sessionDisplayStatus({ status: 'needs_approval', activity: 'completed' })).toBe('needs_approval')
    expect(sessionDisplayStatus({ status: 'stopped', activity: 'running' })).toBe('stopped')
    expect(parseSessionDisplayStatus('待命')).toBe('idle')
    expect(parseSessionDisplayStatus('异常')).toBe('error')
  })

  it('polls complete records only, skips unchanged files and respects the current run boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atm-activity-'))
    try {
      const folder = join(root, '2026', '09')
      await mkdir(folder, { recursive: true })
      const path = join(folder, 'rollout-test-native-one.jsonl')
      const row = (timestamp: number, type: string) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type } })
      await writeFile(path, row(100, 'task_complete') + '\n' + row(300, 'task_started') + '\n' + row(400, 'task_complete'))
      const session = { sessionId: 'manager-one', nativeSessionId: 'native-one',
        agentKind: 'codex', status: 'running', activitySince: 200 } as SessionSummary
      const onActivity = vi.fn()
      const monitor = new NativeSessionActivityMonitor(() => [session], onActivity, { codex: root, claude: root })
      await monitor.poll()
      expect(onActivity).toHaveBeenLastCalledWith(session, { activity: 'running', timestamp: 300 })
      await monitor.poll()
      expect(onActivity).toHaveBeenCalledTimes(1)
      await appendFile(path, '\n')
      await monitor.poll()
      expect(onActivity).toHaveBeenLastCalledWith(session, { activity: 'completed', timestamp: 400 })
      monitor.stop()
      await appendFile(path, row(500, 'task_started') + '\n')
      await monitor.poll()
      expect(onActivity).toHaveBeenCalledTimes(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each(['commentary', 'reasoning'] as const)('recovers %s activity when the start is outside the tail and preserves later completion', async (kind) => {
    const progress = kind === 'commentary'
      ? { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Synthetic progress' }] }
      : { type: 'reasoning', summary: [] }
    await questionMonitor('codex', [
      { timestamp: 300, type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: 350, type: 'event_msg', payload: { type: 'token_count', padding: 'x'.repeat(600_000) } },
      { timestamp: 400, type: 'response_item', payload: progress },
    ], async ({ monitor, events, append }) => {
      await monitor.poll()
      expect(events.at(-1)).toEqual({ activity: 'running', timestamp: 400 })
      await append({ timestamp: 500, type: 'event_msg', payload: { type: 'task_complete' } })
      await monitor.poll()
      expect(events.at(-1)).toEqual({ activity: 'completed', timestamp: 500 })
      await append(codexResult(600, 'late-tool'), { timestamp: 700, type: 'event_msg', payload: { type: 'token_count' } })
      await monitor.poll()
      expect(events.at(-1)).toEqual({ activity: 'completed', timestamp: 500 })
    })
  })

  it('recognizes only actual named question calls, including namespaces', () => {
    expect(parseNativeActivity('codex', codexQuestion(300, 'call-sync'), 'native-one')?.pendingUserQuestions).toEqual([
      { id: 'call-sync', toolName: 'request_user_input', timestamp: 300 },
    ])
    expect(parseNativeActivity('codex', codexQuestion(300, 'call-async', true), 'native-one')?.pendingUserQuestions?.[0]?.toolName).toBe('request_user_input_async')
    expect(parseNativeActivity('claude', { timestamp: 300, type: 'assistant', message: { stop_reason: 'tool_use', content: [
      { type: 'tool_use', name: 'AskUserQuestion', id: 'tool-question', input: { questions: [{ question: 'Which option?' }] } },
    ] } }, 'native-one')?.pendingUserQuestions).toEqual([{ id: 'tool-question', toolName: 'AskUserQuestion', timestamp: 300 }])
    const prose = { timestamp: 300, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'What should I do? request_user_input?' }] } }
    expect(parseNativeActivity('codex', prose, 'native-one')?.pendingUserQuestions).toBeUndefined()
    const otherTool = codexQuestion(300, 'not-a-question')
    otherTool.payload.name = 'functions.search_request_user_input'
    expect(parseNativeActivity('codex', otherTool, 'native-one')?.pendingUserQuestions).toBeUndefined()
    expect(parseNativeActivity('codex', { ...codexQuestion(300, 'child'), agentId: 'child' }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('claude', { timestamp: 300, type: 'assistant', isSidechain: true }, 'native-one')).toBeUndefined()
    expect(parseNativeActivity('codex', { ...codexQuestion(300, 'foreign'), sessionId: 'native-two' }, 'native-one')).toBeUndefined()
  })

  it('keeps a pending question stable across polling and clears only its matching output', async () => {
    await questionMonitor('codex', [codexQuestion(300, 'question-one')], async ({ monitor, events, append }) => {
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions).toEqual([{ id: 'question-one', toolName: 'request_user_input', timestamp: 300 }])
      await monitor.poll()
      expect(events).toHaveLength(1)
      await append(codexResult(400, 'unrelated-call'))
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions?.map(question => question.id)).toEqual(['question-one'])
      await append(codexResult(500, 'question-one'))
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
      const count = events.length
      await monitor.poll()
      expect(events).toHaveLength(count)
    })
  })

  it.each(['mcp__interaction__request_user_input', 'mcp__interaction__request_user_input_async'])(
    'tracks MCP-namespaced question calls and matching answers: %s', async (name) => {
      const async = name.endsWith('_async')
      const original = codexQuestion(300, 'namespaced-call', async)
      const call = { ...original, payload: { ...original.payload, name } }
      await questionMonitor('codex', [call], async ({ monitor, events, append }) => {
        await monitor.poll()
        expect(events.at(-1)?.pendingUserQuestions).toEqual([
          { id: 'namespaced-call', toolName: async ? 'request_user_input_async' : 'request_user_input', timestamp: 300 },
        ])
        await append(codexResult(400, 'namespaced-call'))
        await monitor.poll()
        expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
      })
    },
  )

  it('matches an exact MCP question name without accepting similarly named tools', () => {
    const call = codexQuestion(300, 'named-call')
    for (const name of ['mcp__interaction__search_request_user_input', 'mcp__interaction__request_user_input_history']) {
      expect(parseNativeActivity('codex', { ...call, payload: { ...call.payload, name } }, 'native-one')?.pendingUserQuestions).toBeUndefined()
    }
    expect(parseNativeActivity('claude', { timestamp: 300, type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'mcp__interaction__AskUserQuestion', id: 'claude-namespaced', input: { questions: [{ question: 'Choose a target?' }] } },
    ] } }, 'native-one')?.pendingUserQuestions).toEqual([{ id: 'claude-namespaced', toolName: 'AskUserQuestion', timestamp: 300 }])
  })

  it('accepts the async title and string-options schema while sync and Claude require question text', () => {
    const call = codexQuestion(300, 'async-schema', true)
    expect(JSON.parse(call.payload.arguments)).toEqual({ questions: [{ title: 'Which option?', options: ['first', 'second'] }] })
    expect(parseNativeActivity('codex', call, 'native-one')?.pendingUserQuestions).toEqual([
      { id: 'async-schema', toolName: 'request_user_input_async', timestamp: 300 },
    ])
    expect(parseNativeActivity('codex', { ...call, payload: { ...call.payload, name: 'functions.request_user_input' } }, 'native-one')?.pendingUserQuestions).toBeUndefined()
    expect(parseNativeActivity('claude', { timestamp: 300, type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'AskUserQuestion', id: 'title-only', input: JSON.parse(call.payload.arguments) },
    ] } }, 'native-one')?.pendingUserQuestions).toBeUndefined()
    call.payload.arguments = JSON.stringify({ questions: [{ title: '  ', options: ['first', 'second'] }] })
    expect(parseNativeActivity('codex', call, 'native-one')?.pendingUserQuestions).toBeUndefined()
  })

  it('does not expose answered-in-poll or previous-run questions as new questions', async () => {
    await questionMonitor('codex', [codexQuestion(100, 'history'), codexQuestion(300, 'answered'), codexResult(400, 'answered')], async ({ monitor, events, append }) => {
      await monitor.poll()
      expect(events.every(event => event.pendingUserQuestions === undefined)).toBe(true)
      await append({ timestamp: 500, type: 'event_msg', payload: { type: 'task_started' } })
      await monitor.poll()
      expect(events.every(event => event.pendingUserQuestions === undefined)).toBe(true)
    })
  })

  it('matches Claude AskUserQuestion tool results without treating ordinary user prose as an answer', async () => {
    const question = { timestamp: 300, type: 'assistant', message: { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [{ question: 'Choose a target?' }] } },
    ] } }
    await questionMonitor('claude', [question], async ({ monitor, events, append }) => {
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions?.[0]?.id).toBe('ask-1')
      await append({ timestamp: 400, type: 'user', message: { content: 'Additional task context' } })
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions?.[0]?.id).toBe('ask-1')
      await append({ timestamp: 500, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'User chose target A' }] } })
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
    })
    await questionMonitor('claude', [question, { timestamp: 400, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'A' }] } }], async ({ monitor, events }) => {
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
    })
  })

  it('retains async questions after the immediate acknowledgement until matching user replies arrive', async () => {
    const reply = (timestamp: number, id: string, index: number) => ({ timestamp, type: 'event_msg', payload: { type: 'user_message',
      message: '<send_user_message_question_reply>' + JSON.stringify([{ answer: 'first', question: 'Which option?', questionItemId: JSON.stringify(['request_user_input_async', id, index]) }]) + '</send_user_message_question_reply>',
    } })
    await questionMonitor('codex', [codexQuestion(300, 'async-call', true, 2), codexResult(301, 'async-call', { status: 'pending', request_id: 'async-call', answers: null })], async ({ monitor, events, append }) => {
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions?.[0]?.id).toBe('async-call')
      await append(reply(400, 'unrelated', 0))
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions?.[0]?.id).toBe('async-call')
      await append(reply(500, 'async-call', 0))
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions?.[0]?.id).toBe('async-call')
      await append(reply(600, 'async-call', 1))
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
      await append({ timestamp: 700, type: 'event_msg', payload: { type: 'task_started' } })
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
    })
  })

  it('uses later genuine parent user replies as the legacy async dismissal only', async () => {
    await questionMonitor('codex', [codexQuestion(300, 'async-call', true), codexQuestion(310, 'sync-call')], async ({ monitor, events, append }) => {
      await monitor.poll()
      await append({ timestamp: 400, type: 'event_msg', isMeta: true, payload: { type: 'user_message', message: 'Internal context' } })
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions).toHaveLength(2)
      await append({ timestamp: 500, type: 'event_msg', payload: { type: 'user_message', message: 'Use the first option' } })
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions?.map(question => question.id)).toEqual(['sync-call'])
    })
  })

  it('preserves unanswered questions when their call falls outside the bounded tail', async () => {
    await questionMonitor('codex', [codexQuestion(300, 'old-pending')], async ({ monitor, events, append }) => {
      await monitor.poll()
      await append({ timestamp: 350, type: 'event_msg', payload: { type: 'token_count', padding: 'x'.repeat(600_000) } },
        { timestamp: 400, type: 'event_msg', payload: { type: 'task_started' } })
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions?.[0]?.id).toBe('old-pending')
      await append(codexResult(500, 'old-pending'))
      await monitor.poll()
      expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
    })
  })

  it('delivers question changes even when the UI activity timestamp is already newer', async () => {
    await questionMonitor('codex', [codexQuestion(300, 'question-one')], async ({ monitor, events, session, append }) => {
      session.activityUpdatedAt = 1000
      await monitor.poll()
      expect(events.at(-1)).toMatchObject({ timestamp: 300, pendingUserQuestions: [{ id: 'question-one' }] })
      await append(codexResult(400, 'question-one'))
      await monitor.poll()
      expect(events.at(-1)?.timestamp).toBe(400)
      expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
      expect(session.activityUpdatedAt).toBe(1000)
    })
  })

  it.each(['sync', 'async-result', 'async-reply', 'async-dismissal', 'claude'] as const)(
    'does not resurrect a resolved %s call replayed after its answer leaves the tail', async (mode) => {
      const kind = mode === 'claude' ? 'claude' : 'codex'
      const call = mode === 'claude'
        ? { timestamp: 300, type: 'assistant', message: { content: [
          { type: 'tool_use', name: 'AskUserQuestion', id: 'resolved', input: { questions: [{ question: 'Which option?' }] } },
        ] } }
        : codexQuestion(300, 'resolved', mode !== 'sync')
      const answer = mode === 'claude'
        ? { timestamp: 400, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'resolved', content: 'first' }] } }
        : mode === 'async-reply' || mode === 'async-dismissal'
          ? { timestamp: 400, type: 'event_msg', payload: { type: 'user_message', message: mode === 'async-dismissal' ? 'first'
            : '<send_user_message_question_reply>' + JSON.stringify([{ answer: 'first', questionItemId: JSON.stringify(['request_user_input_async', 'resolved', 0]) }]) + '</send_user_message_question_reply>' } }
          : codexResult(400, 'resolved')
      await questionMonitor(kind, [call, answer], async ({ monitor, events, append, path }) => {
        await monitor.poll()
        expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
        await append({ timestamp: 500, padding: 'x'.repeat(600_000) }, { ...call, timestamp: 600 })
        await monitor.poll()
        expect(events.at(-1)?.timestamp).toBe(600)
        expect(events.at(-1)?.pendingUserQuestions).toBeUndefined()
        // A truncated/replaced transcript starts fresh rather than retaining stale IDs.
        await writeFile(path, JSON.stringify({ ...call, timestamp: 700 }) + '\n')
        await monitor.poll()
        expect(events.at(-1)?.pendingUserQuestions?.[0]?.id).toBe('resolved')
      })
    },
  )
})
