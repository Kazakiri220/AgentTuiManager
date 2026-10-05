import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttentionAudioDelivery } from '../../electron/attention-audio-delivery'

describe('attention audio delivery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  const fixture = () => {
    const port = { send: vi.fn(), fallback: vi.fn(), onDelivery: vi.fn() }
    return { port, delivery: new AttentionAudioDelivery(port) }
  }
  it('uses fallback before the renderer subscribes and after a renderer crash', () => {
    const { port, delivery } = fixture()
    delivery.play()
    expect(port.fallback).toHaveBeenCalledTimes(1)
    delivery.setReady(true); delivery.play(); delivery.setReady(false)
    expect(port.fallback).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(3000)
    expect(port.fallback).toHaveBeenCalledTimes(2)
  })
  it('does not play fallback after a confirmed renderer success', () => {
    const { port, delivery } = fixture()
    delivery.setReady(true); delivery.play()
    const id = port.send.mock.calls[0]![0]
    delivery.acknowledge(id, true)
    vi.advanceTimersByTime(3000)
    delivery.acknowledge(id, false)
    expect(port.fallback).not.toHaveBeenCalled()
    expect(port.onDelivery.mock.calls).toEqual([['renderer_completed']])
  })
  it('falls back once for missing or failed receipts, ignoring invalid receipt data', () => {
    const { port, delivery } = fixture()
    delivery.setReady(true); delivery.play()
    delivery.acknowledge('unknown', false)
    delivery.acknowledge(port.send.mock.calls[0]![0], 'yes')
    vi.advanceTimersByTime(2000)
    expect(port.fallback).toHaveBeenCalledTimes(1)
    delivery.play()
    delivery.acknowledge(port.send.mock.calls[1]![0], false)
    vi.advanceTimersByTime(2000)
    expect(port.fallback).toHaveBeenCalledTimes(2)
    expect(port.onDelivery.mock.calls).toEqual([['native_fallback'], ['native_fallback']])
  })
  it('ignores diagnostic failures without losing fallback delivery', () => {
    const { port, delivery } = fixture()
    port.onDelivery.mockImplementation(() => { throw new Error('Audit unavailable') })
    expect(() => delivery.play()).not.toThrow()
    expect(port.fallback).toHaveBeenCalledOnce()
  })
  it('handles a closed send channel and releases timers on shutdown', () => {
    const { port, delivery } = fixture()
    delivery.setReady(true)
    port.send.mockImplementationOnce(() => { throw new Error('closed') })
    delivery.play()
    expect(port.fallback).toHaveBeenCalledOnce()
    delivery.play(); delivery.dispose()
    vi.advanceTimersByTime(3000)
    expect(port.fallback).toHaveBeenCalledOnce()
  })
})
