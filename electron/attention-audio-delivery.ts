/** Tracks renderer playback receipts so a lost IPC cannot silently eat a reminder. */
export class AttentionAudioDelivery {
  private ready = false
  private sequence = 0
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private readonly port: {
    send(id: string): void
    fallback(): void
    onDelivery?(outcome: 'renderer_completed' | 'native_fallback'): void
  }) {}

  setReady(ready: boolean): void {
    this.ready = ready
    if (!ready) for (const id of [...this.pending.keys()]) this.acknowledge(id, false)
  }

  play(): void {
    if (!this.ready) { this.fallback(); return }
    const id = String(++this.sequence)
    this.pending.set(id, setTimeout(() => this.acknowledge(id, false), 2_000))
    try { this.port.send(id) } catch { this.acknowledge(id, false) }
  }

  acknowledge(id: unknown, success: unknown): void {
    if (typeof id !== 'string' || typeof success !== 'boolean') return
    const timer = this.pending.get(id)
    if (!timer) return
    clearTimeout(timer)
    this.pending.delete(id)
    if (!success) this.fallback()
    else this.diagnostic('renderer_completed')
  }

  private fallback(): void {
    this.port.fallback()
    this.diagnostic('native_fallback')
  }

  private diagnostic(outcome: 'renderer_completed' | 'native_fallback'): void {
    try { this.port.onDelivery?.(outcome) } catch { /* Diagnostics cannot interrupt reminders. */ }
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.ready = false
  }
}
