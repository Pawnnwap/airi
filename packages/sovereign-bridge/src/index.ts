/**
 * @sovereign/bridge — AIRI ↔ Sovereign Core bridge (M1).
 *
 * Single-file, dependency-free, loopback-only. The mind lives in a Python
 * service (`services/sovereign-core/server.py`); this package feeds AIRI's
 * chat-orchestrator seams from it. If the core is unreachable every call
 * no-ops and AIRI runs exactly as upstream.
 *
 * Fork wiring (packages/stage-ui/src/stores/chat.ts, see
 * aiyuri docs/M0-M1-changelist.md):
 *
 *   const sovereign = createSovereignSeams({ port: 8700, getSessionId: ... })
 *   getSystemPromptSupplement: () =>
 *     [sovereign.getSystemPromptSupplement(), llmToolsetPromptsStore.activeToolsetPrompt]
 *       .filter(Boolean).join('\n\n') || undefined,
 *   runtimeContextProviders: [
 *     ...,
 *     () => sovereignContextToMessage(sovereign.runtimeContextProvider(() => lastQuery)()),
 *   ],
 *   onAssistantTurnReady: ({ messageText, sessionMessages }) =>
 *     sovereign.onAssistantTurnReady({ messageText, sessionMessages }),
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
  intents: Array<{ type: string, payload: Record<string, unknown> }>
  memories_used: Array<{ source: string, text: string }>
  provider: string
  trace_id: string
}

/** Shape AIRI's chat.ts turns into a typed ContextMessage. */
export interface SovereignVaultContext {
  contextId: string
  text: string
}

export interface AIRISeamEvent {
  messageText: string
  sessionMessages: unknown[]
}

export interface SovereignSeams {
  /** for `getSystemPromptSupplement?: () => string | undefined` */
  getSystemPromptSupplement: () => string | undefined
  /** for `runtimeContextProviders` — caller wraps into ContextMessage. */
  runtimeContextProvider: (getLastUserText: () => string | undefined) =>
  () => SovereignVaultContext | null | undefined
  /** for `onAssistantTurnReady?: (event: AIRISeamEvent) => void` */
  onAssistantTurnReady: (event: AIRISeamEvent) => void
  client: SovereignClient
}

export interface CreateSovereignSeamsOptions {
  host?: string
  port?: number
  timeoutMs?: number
  recallTokens?: number
  getSessionId?: () => string
}

export const SOVEREIGN_CONTEXT_ID = 'system:sovereign-vault'

function assertLoopback(host: string): void {
  const ok
    = host === '127.0.0.1' || host === 'localhost' || host === '::1'
      || host.startsWith('127.')
  if (!ok) {
    throw new Error(
      `SovereignClient refuses non-loopback host "${host}": the mind is `
      + 'never exposed to the network (plan §12/§27)',
    )
  }
}

export class SovereignClient {
  readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(options: { host?: string, port?: number, timeoutMs?: number } = {}) {
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
    }
    finally {
      clearTimeout(timer)
    }
  }

  status(): Promise<Record<string, unknown>> {
    return this.call('GET', '/v1/status')
  }

  /** Value for AIRI's `getSystemPromptSupplement`. */
  async supplement(): Promise<string | undefined> {
    const { supplement } = await this.call<{ supplement: string }>('GET', '/v1/supplement')
    return supplement || undefined
  }

  /** Provenance-carrying vault recall. */
  async recall(query: string, k = 6): Promise<MemoryRecall[]> {
    const { memories } = await this.call<{ memories: MemoryRecall[] }>(
      'GET',
      `/v1/recall?q=${encodeURIComponent(query)}&k=${k}`,
    )
    return memories
  }

  /** M2 mode: the mind owns the whole turn. */
  turn(text: string, sessionId?: string): Promise<TurnResponse> {
    return this.call('POST', '/v1/turns', { text, session_id: sessionId })
  }

  /** M1 mode: AIRI generated the reply; the core journals the exchange. */
  commitTurn(userText: string, assistantText: string, sessionId?: string): Promise<{
    trace_id: string
    journal: string
  }> {
    return this.call('POST', '/v1/turns/commit', {
      user_text: userText,
      assistant_text: assistantText,
      session_id: sessionId,
    })
  }

  /** Body → mind: report a fact, never a prompt. */
  reportEvent(event: Record<string, unknown>): Promise<{ accepted: string, tick: unknown }> {
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

export function createSovereignSeams(
  options: CreateSovereignSeamsOptions = {},
): SovereignSeams {
  const client = new SovereignClient(options)
  const recallTokens = options.recallTokens ?? 6
  let cached: string | undefined
  let cacheQuery = ''

  const seams: SovereignSeams = {
    getSystemPromptSupplement: () => cached,

    runtimeContextProvider: getLastUserText => () => {
      const q = getLastUserText()
      if (!q?.trim())
        return null
      // AIRI's provider contract is synchronous: the recall matching the
      // PREVIOUS turn's topic is injected (one-turn lag); the fetch refreshes
      // the cache in the background for the next turn.
      void client.recall(q, recallTokens).then((memories) => {
        cached = formatMemories(memories)
        cacheQuery = q
      }).catch(() => { /* mind unreachable → AIRI runs unspoiled */ })
      if (!cached || cacheQuery !== q)
        return null
      return { contextId: SOVEREIGN_CONTEXT_ID, text: cached }
    },

    onAssistantTurnReady: ({ messageText, sessionMessages }) => {
      const userText = lastUserLine(sessionMessages)
      if (!userText)
        return
      void client.commitTurn(
        userText,
        messageText,
        options.getSessionId?.(),
      )
    },

    client,
  }
  return seams
}

export function formatMemories(memories: MemoryRecall[]): string {
  if (!memories.length)
    return ''
  const lines = memories.map(m => `- [${m.source}] ${m.text.replace(/\n/g, ' / ')}`)
  return `# Recalled (from her vault)\n${lines.join('\n')}`
}

function lastUserLine(sessionMessages: unknown[]): string | undefined {
  const msgs = Array.isArray(sessionMessages) ? sessionMessages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { from?: string, role?: string, content?: string, text?: string }
    const isUser = m?.from === 'user' || m?.role === 'user'
    const text = m?.content ?? m?.text
    if (isUser && typeof text === 'string' && text.trim())
      return text
  }
  return undefined
}
