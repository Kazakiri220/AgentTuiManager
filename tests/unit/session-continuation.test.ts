import { describe, expect, it } from 'vitest'
import { freshSessionArgs, nextContinuationName } from '../../electron/session-continuation'

describe('session continuation arguments', () => {
  it('increments continuation names without reusing occupied versions', () => {
    expect(nextContinuationName('AgentTuiManager开发', [])).toBe('AgentTuiManager开发 v1')
    expect(nextContinuationName('AgentTuiManager开发', ['AgentTuiManager开发 v1'])).toBe('AgentTuiManager开发 v2')
    expect(nextContinuationName('AgentTuiManager开发 v2', ['AgentTuiManager开发 v3'])).toBe('AgentTuiManager开发 v4')
  })

  it('removes resume switches but preserves Claude config overrides', () => {
    expect(freshSessionArgs('claude', [
      '--resume', 'old-session',
      '-c', 'hooks.PermissionRequest=[{"type":"command"}]',
      '-c', 'tui.notifications=true',
      '--model', 'sonnet',
    ])).toEqual([
      '-c', 'hooks.PermissionRequest=[{"type":"command"}]',
      '-c', 'tui.notifications=true',
      '--model', 'sonnet',
    ])
  })

  it('removes Codex resume identity while keeping provider arguments', () => {
    expect(freshSessionArgs('codex', ['resume', 'old-session', '-c', 'model=x', '--profile', 'work'])).toEqual([
      '-c', 'model=x', '--profile', 'work',
    ])
  })
})
