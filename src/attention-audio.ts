let context: AudioContext | undefined

/** A short two-tone chime independent of the Windows system sound scheme. */
export async function playAttentionAudio(): Promise<void> {
  if (!context || context.state === 'closed') context = new AudioContext()
  const audio = context
  await new Promise<void>((resolve, reject) => {
    const nodes: Array<{ oscillator: OscillatorNode; gain: GainNode; ended: boolean }> = []
    let settled = false
    let remaining = 2
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const node of nodes) {
        node.oscillator.onended = null
        if (!node.ended) {
          try { node.oscillator.stop() } catch { /* It may not have started. */ }
          node.oscillator.disconnect(); node.gain.disconnect()
        }
      }
      if (error) reject(error)
      else resolve()
    }
    // Includes resume(): a suspended context can leave that promise pending.
    // Reject before the main process's receipt timeout so it can use its fallback.
    const timer = setTimeout(() => finish(new Error('Audio playback timed out')), 1500)
    void (async () => {
      if (audio.state !== 'running') await audio.resume()
      if (settled) return
      if (audio.state !== 'running') throw new Error('Audio output unavailable')
      const start = audio.currentTime + 0.02
      for (const [offset, frequency] of [[0, 660], [0.14, 880]]) {
        const oscillator = audio.createOscillator()
        const gain = audio.createGain()
        const node = { oscillator, gain, ended: false }
        nodes.push(node)
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency!
        const at = start + offset!
        gain.gain.setValueAtTime(0, at)
        gain.gain.linearRampToValueAtTime(0.12, at + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.16)
        oscillator.connect(gain); gain.connect(audio.destination)
        oscillator.onended = () => {
          if (settled || node.ended) return
          node.ended = true
          oscillator.disconnect(); gain.disconnect()
          if (audio.state !== 'running') finish(new Error('Audio output unavailable'))
          else if (--remaining === 0) finish()
        }
        oscillator.start(at); oscillator.stop(at + 0.18)
      }
    })().catch(error => finish(error instanceof Error ? error : new Error('Audio output unavailable')))
  })
}
