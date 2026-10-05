let context: AudioContext | undefined

/** A short two-tone chime independent of the Windows system sound scheme. */
export async function playAttentionAudio(): Promise<void> {
  if (!context || context.state === 'closed') context = new AudioContext()
  const audio = context
  if (audio.state !== 'running') await audio.resume()
  if (audio.state !== 'running') throw new Error('Audio output unavailable')
  const start = audio.currentTime + 0.02
  for (const [offset, frequency] of [[0, 660], [0.14, 880]]) {
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency!
    const at = start + offset!
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.12, at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.16)
    oscillator.connect(gain); gain.connect(audio.destination)
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
    oscillator.start(at); oscillator.stop(at + 0.18)
  }
}
