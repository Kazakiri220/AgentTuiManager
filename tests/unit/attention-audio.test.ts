import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('attention chime', () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers() })
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers() })
  const fixture = (initial = 'running') => {
    const oscillators: Array<{ frequency: { value: number }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended?: () => void; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
    const ctx = {
      state: initial, currentTime: 10, destination: {},
      resume: vi.fn(async () => { ctx.state = 'running' }),
      createOscillator: vi.fn(() => { const osc = { frequency: { value: 0 }, start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }; oscillators.push(osc); return osc }),
      createGain: vi.fn(() => ({ gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() })),
    }
    vi.stubGlobal('AudioContext', vi.fn(() => ctx))
    return { ctx, oscillators }
  }
  it('resumes suspended audio and releases tone nodes after playing', async () => {
    const { ctx, oscillators } = fixture('suspended')
    const { playAttentionAudio } = await import('../../src/attention-audio')
    const finished = vi.fn()
    const playback = playAttentionAudio().then(finished)
    await Promise.resolve()
    expect(ctx.resume).toHaveBeenCalledOnce()
    expect(oscillators.map(osc => osc.frequency.value)).toEqual([660, 880])
    expect(finished).not.toHaveBeenCalled()
    oscillators[0]!.onended?.()
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    oscillators[1]!.onended?.()
    await playback
    expect(finished).toHaveBeenCalledOnce()
    for (const osc of oscillators) { expect(osc.start).toHaveBeenCalledOnce(); expect(osc.stop).toHaveBeenCalledOnce(); expect(osc.disconnect).toHaveBeenCalledOnce() }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects unavailable audio so IPC can request the native fallback', async () => {
    const { ctx } = fixture('suspended')
    ctx.resume.mockImplementation(async () => undefined)
    const { playAttentionAudio } = await import('../../src/attention-audio')
    await expect(playAttentionAudio()).rejects.toThrow('Audio output unavailable')
    expect(ctx.createOscillator).not.toHaveBeenCalled()
  })
  it.each(['resume', 'playback'])('rejects stalled %s before the main receipt deadline', async stage => {
    const { ctx, oscillators } = fixture(stage === 'resume' ? 'suspended' : 'running')
    if (stage === 'resume') ctx.resume.mockImplementation(() => new Promise<void>(() => undefined))
    const { playAttentionAudio } = await import('../../src/attention-audio')
    const result = expect(playAttentionAudio()).rejects.toThrow('Audio playback timed out')
    await vi.advanceTimersByTimeAsync(1500)
    await result
    for (const osc of oscillators) expect(osc.disconnect).toHaveBeenCalledOnce()
  })
  it('reports a context interrupted before the chime ends as unavailable', async () => {
    const { ctx, oscillators } = fixture()
    const { playAttentionAudio } = await import('../../src/attention-audio')
    const result = expect(playAttentionAudio()).rejects.toThrow('Audio output unavailable')
    ctx.state = 'suspended'
    oscillators[0]!.onended?.()
    await result
    expect(vi.getTimerCount()).toBe(0)
    for (const osc of oscillators) expect(osc.disconnect).toHaveBeenCalledOnce()
  })
})
