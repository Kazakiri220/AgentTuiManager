import { describe, expect, it } from 'vitest'
import { autoCompactArgs } from '../../src/shared/auto-compact'

describe('automatic context compaction arguments', () => {
  it('adds Claude autocompact before the prompt separator', () => {
    expect(autoCompactArgs('claude', ['--model', 'sonnet', '--', 'old prompt'], 200_000)).toEqual([
      '--model', 'sonnet', '--autocompact', '200000', '--', 'old prompt',
    ])
  })

  it('adds Codex config before the prompt separator', () => {
    expect(autoCompactArgs('codex', ['--', 'prompt'], 120_000)).toEqual([
      '-c', 'model_auto_compact_token_limit=120000', '--', 'prompt',
    ])
  })
})
