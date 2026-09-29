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
  /** Load identity and recall before the synchronous AIRI prompt hooks run. */
  prepareTurn: (query: string) => Promise<void>
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
  token?: string
}

export const SOVEREIGN_CONTEXT_ID = 'system:sovereign-vault'

export interface SovereignRequest {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  timeoutMs: number
}

export type SovereignTransport = (request: SovereignRequest) => Promise<unknown>

let hostTransport: SovereignTransport | undefined

/** Desktop registers its main-process Eventa transport before chat starts. */
export function configureSovereignTransport(transport: SovereignTransport): void {
  hostTransport = transport
}

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
  private readonly token?: string

  constructor(options: { host?: string, port?: number, timeoutMs?: number, token?: string } = {}) {
    const host = options.host ?? '127.0.0.1'
    const port = options.port ?? 8700
    assertLoopback(host)
    this.baseUrl = `http://${host}:${port}`
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.token = options.token
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (hostTransport)
      return await hostTransport({ method, path, body, timeoutMs: this.timeoutMs }) as T
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
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

  /** M2 mode: the mind owns the whole turn. Aborting prevents its commit. */
  async turn(text: string, sessionId?: string, signal?: AbortSignal): Promise<TurnResponse> {
    const requestId = crypto.randomUUID()
    if (signal?.aborted)
      throw signal.reason ?? new Error('turn cancelled')
    const pending = this.call<TurnResponse>('POST', '/v1/turns', {
      text,
      session_id: sessionId,
      request_id: requestId,
    })
    if (!signal)
      return pending
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void this.call('POST', '/v1/turns/cancel', { request_id: requestId }).catch(() => {})
        reject(signal.reason ?? new Error('turn cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted)
        onAbort()
    })
    try {
      return await Promise.race([pending, aborted])
    }
    finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** M1 mode: AIRI generated the reply; the core journals the exchange. */
  commitTurn(userText: string, assistantText: string, sessionId?: string): Promise<{
    trace_id: string
    journal: string
    intents?: Array<{ type: string, payload: Record<string, unknown> }>
  }> {
    return this.call('POST', '/v1/turns/commit', {
      user_text: userText,
      assistant_text: assistantText,
      session_id: sessionId,
    }).then((r) => {
      // The mind→body boundary (plan §23): every committed exchange fans its
      // intents out to subscribed bodies (stage adapter, webchat, …).
      if (r.intents?.length)
        emitSovereignIntents(r.intents)
      return r
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
  let cachedSupplement: string | undefined
  const recalled = new Map<string, string>()

  const prepareTurn = async (query: string): Promise<void> => {
    const clean = query.trim()
    const [supplement, memories] = await Promise.allSettled([
      client.supplement(),
      clean ? client.recall(clean, recallTokens) : Promise.resolve([]),
    ])
    if (supplement.status === 'fulfilled')
      cachedSupplement = supplement.value
    if (memories.status === 'fulfilled' && clean) {
      recalled.set(clean, formatMemories(memories.value))
      if (recalled.size > 8) {
        const oldest = recalled.keys().next().value
        if (oldest !== undefined)
          recalled.delete(oldest)
      }
    }
  }

  const seams: SovereignSeams = {
    prepareTurn,
    getSystemPromptSupplement: () => cachedSupplement,

    runtimeContextProvider: getLastUserText => () => {
      const q = getLastUserText()
      if (!q?.trim())
        return null
      const cached = recalled.get(q.trim())
      if (!cached) {
        void prepareTurn(q)
        return null
      }
      return { contextId: SOVEREIGN_CONTEXT_ID, text: cached }
    },

    onAssistantTurnReady: ({ messageText, sessionMessages }) => {
      const userText = lastUserLine(sessionMessages)
      if (!userText)
        return
      // commitTurn itself fans intents out on the bus (single emit point)
      void client.commitTurn(
        userText,
        messageText,
        options.getSessionId?.(),
      ).catch(() => {})
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

// ---- intents bus (mind → any body, plan §9/§23) ----------------------------

type IntentHandler = (intents: Array<{ type: string, payload: Record<string, unknown> }>) => void
const intentHandlers = new Set<IntentHandler>()

/** Fan intents out to every subscribed body (stage adapter, webchat, …). */
export function emitSovereignIntents(
  intents: Array<{ type: string, payload: Record<string, unknown> }>,
): void {
  for (const h of intentHandlers)
    h(intents)
}

/** Subscribe a body; returns an unsubscribe function. */
export function onSovereignIntents(handler: IntentHandler): () => void {
  intentHandlers.add(handler)
  return () => intentHandlers.delete(handler)
}
