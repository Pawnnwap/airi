/**
 * SovereignClient — loopback-only HTTP client for the Sovereign Core service
 * (`services/sovereign-core/server.py`). M1 of docs/M0-M1-changelist.md.
 *
 * Sovereignty rules baked in:
 *  - default base URL is 127.0.0.1; the client refuses non-loopback hosts
 *  - no credentials, no telemetry, no retries-with-backoff storming the core
 */

export interface MemoryRecall {
  text: string
  source: string
  kind: string
  score: number
  similarity: number
  salience: number
  created_at?: string
  memory_id?: string
}

export interface TurnResponse {
  reply: string
  intents: Array<{ type: string; payload: Record<string, unknown> }>
  memories_used: Array<{ source: string; text: string }>
  provider: string
  trace_id: string
}

export interface SovereignClientOptions {
  host?: string
  port?: number
  /** milliseconds; a stuck mind surfaces as an error, not a hang */
  timeoutMs?: number
}

function assertLoopback(host: string): void {
  const ok =
    host === '127.0.0.1' || host === 'localhost' || host === '::1' ||
    host.startsWith('127.')
  if (!ok)
    throw new Error(
      `SovereignClient refuses non-loopback host "${host}": the mind is ` +
      'never exposed to the network (plan §12/§27)')
}

export class SovereignClient {
  readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(options: SovereignClientOptions = {}) {
    const host = options.host ?? '127.0.0.1'
    const port = options.port ?? 8700
    assertLoopback(host)
    this.baseUrl = `http://${host}:${port}`
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok)
        throw new Error(`sovereign-core ${path} -> ${res.status}: ${JSON.stringify(payload)}`)
      return payload as T
    } finally {
      clearTimeout(timer)
    }
  }

  status(): Promise<Record<string, unknown>> {
    return this.call('GET', '/v1/status')
  }

  /** Value for AIRI's `getSystemPromptSupplement` (chat-orchestrator-runtime.ts L254). */
  async supplement(): Promise<string | undefined> {
    const { supplement } = await this.call<{ supplement: string }>('GET', '/v1/supplement')
    return supplement || undefined
  }

  /** Value for AIRI's `runtimeContextProviders` (L256). */
  async recall(query: string, k = 6): Promise<MemoryRecall[]> {
    const { memories } = await this.call<{ memories: MemoryRecall[] }>(
      'GET', `/v1/recall?q=${encodeURIComponent(query)}&k=${k}`)
    return memories
  }

  /**
   * Full mind turn (M2 mode: AIRI is pure body). Only used once the fork
   * replaces the `llm.stream` port; M1 does NOT call this from the UI path.
   */
  turn(text: string, sessionId?: string): Promise<TurnResponse> {
    return this.call('POST', '/v1/turns', { text, session_id: sessionId })
  }

  /** Wire into `onAssistantTurnReady` (L367): commit the closed exchange. */
  commitTurn(userText: string, assistantText: string, sessionId?: string): Promise<{
    trace_id: string
    journal: string
  }> {
    // M1 commit: AIRI generated the reply; the core journals it, updates
    // relationship and catches promises. No generation happens here.
    return this.call('POST', '/v1/turns/commit', {
      user_text: userText, assistant_text: assistantText, session_id: sessionId,
    })
  }

  /** Wire into any perception surface: report a fact, never a prompt. */
  reportEvent(event: Record<string, unknown>): Promise<{ accepted: string; tick: unknown }> {
    return this.call('POST', '/v1/events', event)
  }

  dream(): Promise<Record<string, unknown>> {
    return this.call('POST', '/v1/dream')
  }

  forget(selector: string): Promise<{ forgotten: number }> {
    return this.call('POST', '/v1/forget', { selector })
  }

  erase(selector: string): Promise<{ erased: number }> {
    return this.call('POST', '/v1/erase', { selector })
  }

  checkCapability(id: string, mode: 'interactive' | 'autonomous' = 'interactive'): Promise<{
    allowed: boolean
    reason: string
    requires_confirmation: boolean
  }> {
    return this.call('POST', '/v1/capabilities/check', { id, mode })
  }
}
