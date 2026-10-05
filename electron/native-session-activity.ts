import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AgentKind, SessionSummary } from '../src/shared/manager-api'
import type { SessionActivity } from '../src/shared/session-state'

export interface NativeUserQuestion {
  id: string
  toolName: 'request_user_input' | 'request_user_input_async' | 'AskUserQuestion'
  timestamp: number
}

export interface NativeActivityEvent {
  activity: SessionActivity
  timestamp: number
  error?: string
  userMessage?: { text: string; timestamp: number }
  assistantMessage?: { text: string; timestamp: number }
  /** Current unanswered parent-session calls. Omitted means the snapshot is empty. */
  pendingUserQuestions?: NativeUserQuestion[]
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function nativeRecord(value: unknown, sessionId: string): { record: Record<string, unknown>; timestamp: number } | undefined {
  const record = object(value)
  if (!record || record.isSidechain === true || record.agentId
    || typeof record.sessionId === 'string' && record.sessionId !== sessionId) return undefined
  const timestamp = typeof record.timestamp === 'number' ? record.timestamp : Date.parse(String(record.timestamp ?? ''))
  if (!Number.isFinite(timestamp)) return undefined
  return { record, timestamp }
}

interface QuestionCall { question: NativeUserQuestion; count: number }
interface PendingQuestion extends QuestionCall { unanswered: Set<number> }

function questionToolName(value: unknown): NativeUserQuestion['toolName'] | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.split(/(?:[.:/]|__)/).at(-1)
  return name === 'request_user_input' || name === 'request_user_input_async' || name === 'AskUserQuestion' ? name : undefined
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch { return undefined }
  }
  return object(value)
}

function questionCall(name: unknown, id: unknown, input: unknown, timestamp: number): QuestionCall | undefined {
  const toolName = questionToolName(name)
  const argumentsValue = jsonObject(input)
  const questions = argumentsValue?.questions
  if (!toolName || typeof id !== 'string' || !id || id.length > 512 || !Array.isArray(questions)
    || !questions.length || !questions.every((item) => {
      const question = object(item)
      const text = toolName === 'request_user_input_async' ? question?.title ?? question?.question : question?.question
      return typeof text === 'string' && text.trim()
    })) return undefined
  return { question: { id, toolName, timestamp }, count: questions.length }
}

function questionCalls(kind: AgentKind, record: Record<string, unknown>, timestamp: number): QuestionCall[] {
  const calls: QuestionCall[] = []
  if (kind === 'codex' && record.type === 'response_item') {
    const payload = object(record.payload)
    if (payload && ['function_call', 'custom_tool_call'].includes(String(payload.type))) {
      const call = questionCall(payload.name, payload.call_id ?? payload.id, payload.arguments ?? payload.input, timestamp)
      if (call && call.question.toolName !== 'AskUserQuestion') calls.push(call)
    }
  } else if (kind === 'claude' && record.type === 'assistant') {
    const content = object(record.message)?.content
    for (const value of Array.isArray(content) ? content : []) {
      const block = object(value)
      if (block?.type !== 'tool_use') continue
      const call = questionCall(block.name, block.id, block.input, timestamp)
      if (call?.question.toolName === 'AskUserQuestion') calls.push(call)
    }
  }
  return calls
}

/** Update question state from structured calls/results only; never inspect prose for '?'. */
function updateQuestions(kind: AgentKind, record: Record<string, unknown>, timestamp: number,
  pending: Map<string, PendingQuestion>, settled: Set<string>): void {
  const resolve = (id: string): void => {
    if (pending.delete(id)) settled.add(id)
  }
  for (const call of questionCalls(kind, record, timestamp)) {
    if (!pending.has(call.question.id) && !settled.has(call.question.id)) {
      pending.set(call.question.id, { ...call, unanswered: new Set(Array.from({ length: call.count }, (_, index) => index)) })
    }
  }
  if (kind === 'codex') {
    const payload = object(record.payload)
    if (!payload) return
    if (record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(String(payload.type))) {
      const id = typeof payload.call_id === 'string' ? payload.call_id : undefined
      const call = id ? pending.get(id) : undefined
      if (call) {
        const output = jsonObject(payload.output ?? payload.result ?? payload.content)
        // Async tools return an acknowledgement immediately. Only an actual
        // answer/cancellation/error result closes their pending question.
        const acknowledgement = output && ['pending', 'queued', 'waiting', 'requested'].includes(String(output.status))
        const answered = output && !acknowledgement && (Object.prototype.hasOwnProperty.call(output, 'answers')
          || Object.prototype.hasOwnProperty.call(output, 'answer') || output.error !== undefined
          || ['answered', 'cancelled', 'canceled', 'dismissed', 'failed', 'error'].includes(String(output.status)))
        if (call.question.toolName !== 'request_user_input_async' || answered || payload.is_error === true) resolve(id!)
      }
    }
    if (record.type === 'event_msg' && payload.type === 'user_message' && record.isMeta !== true && typeof payload.message === 'string') {
      const replies = [...payload.message.matchAll(/<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/g)]
      if (replies.length) {
        for (const reply of replies) {
          let answers: unknown
          try { answers = JSON.parse(reply[1]!) } catch { continue }
          for (const answer of Array.isArray(answers) ? answers : []) {
            const item = object(answer)
            if (!item || !Object.prototype.hasOwnProperty.call(item, 'answer') || typeof item.questionItemId !== 'string') continue
            let identity: unknown
            try { identity = JSON.parse(item.questionItemId) } catch { continue }
            if (!Array.isArray(identity) || identity[0] !== 'request_user_input_async'
              || typeof identity[1] !== 'string' || !Number.isInteger(identity[2])) continue
            const call = pending.get(identity[1])
            if (!call || call.question.toolName !== 'request_user_input_async' || timestamp < call.question.timestamp) continue
            call.unanswered.delete(identity[2] as number)
            if (!call.unanswered.size) resolve(identity[1])
          }
        }
      } else if (!payload.message.includes('<send_user_message_question_reply>')) {
        // Older clients expose an async answer as an ordinary parent user turn.
        // Such a reply dismisses async prompts only; synchronous tools still need
        // their matching tool result. Meta/sidechain records never reach here.
        for (const [id, call] of pending) {
          if (call.question.toolName === 'request_user_input_async' && timestamp >= call.question.timestamp) resolve(id)
        }
      }
    }
  } else if (kind === 'claude' && record.type === 'user') {
    const content = object(record.message)?.content
    for (const value of Array.isArray(content) ? content : []) {
      const block = object(value)
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') resolve(block.tool_use_id)
    }
  }
}

export function parseNativeActivity(kind: AgentKind, value: unknown, sessionId: string): NativeActivityEvent | undefined {
  const native = nativeRecord(value, sessionId)
  if (!native) return undefined
  const { record, timestamp } = native
  const questions = questionCalls(kind, record, timestamp).map((call) => call.question)
  const result = (activity: SessionActivity, error?: unknown): NativeActivityEvent => ({
    activity, timestamp, ...(typeof error === 'string' ? { error: error.slice(0, 2000) } : {}),
    ...(questions.length ? { pendingUserQuestions: questions } : {}),
  })
  if (kind === 'codex') {
    const payload = object(record.payload)
    if (!payload) return undefined
    if (record.type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        return { ...result('running'), userMessage: { text: payload.message, timestamp } }
      }
      if (payload.type === 'task_started' || payload.type === 'user_message') return result('running')
      if (payload.type === 'agent_reasoning') return result('running')
      if (payload.type === 'task_complete') return { ...result(payload.error ? 'error' : 'completed',
        payload.error ? object(payload.error)?.message ?? (typeof payload.error === 'string' ? payload.error : 'Codex 当前任务异常结束') : undefined),
        ...(typeof payload.last_agent_message === 'string' ? { assistantMessage: { text: payload.last_agent_message, timestamp } } : {}) }
      if (payload.type === 'turn_aborted') return result('idle')
      if (payload.type === 'error') return result(payload.will_retry === true ? 'running' : 'error', payload.message)
    }
    if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(String(payload.type))) return result('running')
    if (record.type === 'response_item' && payload.type === 'reasoning') return result('running')
    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      // Commentary is activity evidence, but must not trigger final-answer
      // keywords or unattended end-word matching.
      if (payload.phase === 'commentary') return result('running')
      const text = Array.isArray(payload.content) ? payload.content.filter(item => object(item)?.type === 'output_text')
        .map(item => object(item)?.text).filter(item => typeof item === 'string').join('\n') : ''
      if (text) return { ...result('running'), assistantMessage: { text, timestamp } }
    }
  } else if (kind === 'claude') {
    const message = object(record.message)
    if (record.type === 'assistant' && record.isApiErrorMessage === true) {
      const text = Array.isArray(message?.content)
        ? message.content.map((item: unknown) => object(item)?.text).filter((item): item is string => typeof item === 'string').join('\n')
        : 'Claude Code 请求失败'
      return result('error', text)
    }
    if (record.type === 'user' && record.isMeta !== true) {
      const content = message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        && content.every(item => object(item)?.type === 'text')
        ? content.map(item => object(item)?.text).filter(item => typeof item === 'string').join('\n') : undefined
      return { ...result('running'), ...(text ? { userMessage: { text, timestamp } } : {}) }
    }
    if (record.type === 'assistant' && message) {
      const text = Array.isArray(message.content) ? message.content.filter(item => object(item)?.type === 'text')
        .map(item => object(item)?.text).filter(item => typeof item === 'string').join('\n') : ''
      return { ...result(['end_turn', 'stop_sequence'].includes(String(message.stop_reason)) ? 'completed' : 'running'),
        ...(text ? { assistantMessage: { text, timestamp } } : {}) }
    }
    if (record.type === 'system' && record.subtype === 'turn_duration') return result('completed')
  }
  return undefined
}

interface FileCursor {
  path: string; size: number; mtime: number; questions: Map<string, PendingQuestion>
  /** Keep resolved IDs for this run even after their answers leave the tail. */
  settledQuestionIds: Set<string>
}

/** Read-only, bounded tail polling. Never sends input or changes approval/recovery. */
export class NativeSessionActivityMonitor {
  private readonly files = new Map<string, FileCursor>()
  private readonly missingUntil = new Map<string, number>()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(
    private readonly sessions: () => SessionSummary[],
    private readonly onActivity: (session: SessionSummary, event: NativeActivityEvent) => void,
    private readonly roots = {
      codex: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
      claude: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
    },
  ) {}

  start(): void {
    this.stopped = false
    const tick = async (): Promise<void> => {
      try { await this.poll() } finally {
        if (!this.stopped) {
          this.timer = setTimeout(() => { void tick() }, 2000)
          this.timer.unref?.()
        }
      }
    }
    void tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  async poll(): Promise<void> {
    const sessions = this.sessions().filter((session) => session.nativeSessionId
      && (session.agentKind === 'codex' || session.agentKind === 'claude')
      && (!['completed', 'stopped', 'failed'].includes(session.status) || session.unattended?.enabled))
    const activeKeys = new Set(sessions.map((session) => this.key(session)))
    for (const key of this.files.keys()) if (!activeKeys.has(key)) this.files.delete(key)
    for (const key of this.missingUntil.keys()) if (!activeKeys.has(key)) this.missingUntil.delete(key)
    for (const session of sessions) {
      const key = this.key(session)
      try {
        let cursor = this.files.get(key)
        if (!cursor) {
          if ((this.missingUntil.get(key) ?? 0) > Date.now()) continue
          const path = await this.findFile(session.agentKind as 'codex' | 'claude', session.nativeSessionId!)
          if (!path) { this.missingUntil.set(key, Date.now() + 30_000); continue }
          cursor = { path, size: -1, mtime: -1, questions: new Map(), settledQuestionIds: new Set() }
          this.files.set(key, cursor)
          this.missingUntil.delete(key)
        }
        const stat = await fs.stat(cursor.path)
        if (stat.size === cursor.size && stat.mtimeMs === cursor.mtime) continue
        const previousQuestions = [...cursor.questions.keys()].sort().join('\n')
        if (stat.size < cursor.size) {
          cursor.questions.clear()
          cursor.settledQuestionIds.clear()
        }
        const file = await fs.open(cursor.path, 'r')
        let text: string
        try {
          const offset = Math.max(0, stat.size - 512 * 1024)
          const buffer = Buffer.alloc(stat.size - offset)
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          text = buffer.subarray(0, bytesRead).toString('utf8')
          if (offset > 0) text = text.slice(text.indexOf('\n') + 1)
        } finally { await file.close() }
        let latest: NativeActivityEvent | undefined
        let userMessage: NativeActivityEvent['userMessage']
        let assistantMessage: NativeActivityEvent['assistantMessage']
        let questionTimestamp = 0
        // Ignore the last partial JSONL record; revisit it after the next append.
        for (const line of text.split('\n').slice(0, -1)) {
          let value: unknown
          try { value = JSON.parse(line) } catch { continue }
          const native = nativeRecord(value, session.nativeSessionId!)
          if (native && native.timestamp >= (session.activitySince ?? 0)) {
            const previousSize = cursor.questions.size
            updateQuestions(session.agentKind, native.record, native.timestamp, cursor.questions, cursor.settledQuestionIds)
            if (previousSize !== cursor.questions.size) questionTimestamp = Math.max(questionTimestamp, native.timestamp)
          }
          const event = parseNativeActivity(session.agentKind, value, session.nativeSessionId!)
          if (event?.userMessage && event.timestamp >= (session.activitySince ?? 0)
            && (!userMessage || event.timestamp >= userMessage.timestamp)) userMessage = event.userMessage
          if (event?.assistantMessage && event.timestamp >= (session.activitySince ?? 0)
            && (!assistantMessage || event.timestamp >= assistantMessage.timestamp)) assistantMessage = event.assistantMessage
          if (event && event.timestamp >= (session.activitySince ?? 0)
            && event.timestamp >= (session.activityUpdatedAt ?? 0)
            && (!latest || event.timestamp >= latest.timestamp)) latest = event
        }
        cursor.size = stat.size
        cursor.mtime = stat.mtimeMs
        const questions = [...cursor.questions.values()].map((call) => ({ ...call.question }))
          .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
        const questionsChanged = previousQuestions !== [...cursor.questions.keys()].sort().join('\n')
        const emit = (event: NativeActivityEvent): void => {
          // A row-level call can be answered later in this same poll. Only the
          // final snapshot is exposed; callers never hear about that answered call.
          const { pendingUserQuestions: _rowQuestions, ...activity } = event
          this.onActivity(session, { ...activity, ...(questions.length ? { pendingUserQuestions: questions } : {}) })
        }
        if (latest && !this.stopped) emit({ ...latest, ...(userMessage ? { userMessage } : {}), ...(assistantMessage ? { assistantMessage } : {}) })
        else if (assistantMessage && !this.stopped) {
          emit({ activity: 'running', timestamp: assistantMessage.timestamp, assistantMessage, ...(userMessage ? { userMessage } : {}) })
        }
        else if (userMessage && !this.stopped) {
          // Evidence may predate an optimistic UI activity update. Deliver it
          // without rolling that activity back in the controller.
          emit({ activity: 'running', timestamp: userMessage.timestamp, userMessage })
        } else if (questionsChanged && !this.stopped) {
          // Tool outputs are not otherwise activity events. Still deliver the
          // cleared snapshot even when an optimistic UI timestamp is newer.
          emit({ activity: 'running', timestamp: questionTimestamp || stat.mtimeMs })
        }
      } catch {
        // Missing/rotated/unreadable transcripts must not interrupt the Agent.
        this.files.delete(key)
        this.missingUntil.set(key, Date.now() + 30_000)
      }
    }
  }

  private key(session: SessionSummary): string {
    return [session.sessionId, session.nativeSessionId, session.activitySince ?? 0].join(':')
  }

  private async findFile(kind: 'codex' | 'claude', id: string): Promise<string | undefined> {
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(id)) return undefined
    const directories = [this.roots[kind]]
    let visited = 0
    while (directories.length && visited < 20_000) {
      const directory = directories.pop()!
      let entries
      try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (++visited > 20_000) break
        if (entry.isDirectory() && entry.name !== 'subagents') directories.push(join(directory, entry.name))
        else if (entry.isFile() && (kind === 'claude' ? entry.name === id + '.jsonl'
          : entry.name.startsWith('rollout-') && entry.name.endsWith('-' + id + '.jsonl'))) return join(directory, entry.name)
      }
    }
    return undefined
  }
}
