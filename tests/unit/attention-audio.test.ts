import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('attention chime', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())
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
    await playAttentionAudio()
    expect(ctx.resume).toHaveBeenCalledOnce()
    expect(oscillators.map(osc => osc.frequency.value)).toEqual([660, 880])
    for (const osc of oscillators) { expect(osc.start).toHaveBeenCalledOnce(); expect(osc.stop).toHaveBeenCalledOnce(); osc.onended?.(); expect(osc.disconnect).toHaveBeenCalledOnce() }
  })
  it('rejects unavailable audio so IPC can request the native fallback', async () => {
    const { ctx } = fixture('suspended')
    ctx.resume.mockImplementation(async () => undefined)
    const { playAttentionAudio } = await import('../../src/attention-audio')
    await expect(playAttentionAudio()).rejects.toThrow('Audio output unavailable')
    expect(ctx.createOscillator).not.toHaveBeenCalled()
  })
})
