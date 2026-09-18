/**
 * createSovereignSeams — values that drop into the AIRI chat orchestrator
 * deps object (`packages/stage-ui/src/stores/chat.ts`, lines ~320–370 of the
 * frozen upstream; see docs/M0-M1-changelist.md).
 *
 * M1 wiring in the fork's chat.ts becomes:
 *
 *   import { createSovereignSeams } from '@sovereign/bridge'
 *   const sovereign = createSovereignSeams({ port: 8700 })
 *
 *   getSystemPromptSupplement: () =>
 *     [sovereign.getSystemPromptSupplement(), llmToolsetPromptsStore.activeToolsetPrompt]
 *       .filter(Boolean).join('\n\n'),
 *   runtimeContextProviders: [
 *     () => createRuntimePromptContext(runtimePrompt.value),
 *     createMinecraftContext,
 *     sovereign.runtimeContextProvider(() => lastUserText.value),
 *   ],
 *   onAssistantTurnReady: ({ messageText, sessionMessages }) => {
 *     sovereign.onAssistantTurnReady({ messageText, sessionMessages })
 *   },
 */

import { SovereignClient, type MemoryRecall } from './client.ts'

export interface AIRISeamEvent {
  messageText: string
  sessionMessages: unknown[]
}

export interface SovereignSeams {
  /** for `getSystemPromptSupplement?: () => string | undefined` */
  getSystemPromptSupplement: () => string | undefined
  /** for `runtimeContextProviders?: Array<() => ContextMessage | null | undefined>` —
   *  returns an object shaped like AIRI's ContextMessage; cast at the wiring
   *  site if AIRI's type declares stricter fields. */
  runtimeContextProvider: (getLastUserText: () => string | undefined) =>
    () => { role: 'system'; content: string } | null | undefined
  /** for `onAssistantTurnReady?: (event: AIRISeamEvent) => void` */
  onAssistantTurnReady: (event: AIRISeamEvent) => void
  /** direct client access (status, dream, forget, events, capabilities) */
  client: SovereignClient
}

export interface CreateSovereignSeamsOptions {
  host?: string
  port?: number
  timeoutMs?: number
  recallTokens?: number
  /** session id forwarded to the core for journal grouping */
  getSessionId?: () => string
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
      // fetch asynchronously but return a value this tick: AIRI's provider
      // contract is synchronous, so the recall that matches the PREVIOUS
      // turn's topic is injected (one-turn lag), and the supplement cache
      // is refreshed in the background for the next turn.
      void client.recall(q, recallTokens).then(memories => {
        cached = formatMemories(memories)
        cacheQuery = q
      }).catch(() => { /* mind unreachable → AIRI runs unspoiled */ })
      if (!cached || cacheQuery !== q)
        return null
      return { role: 'system', content: cached }
    },

    onAssistantTurnReady: ({ messageText, sessionMessages }) => {
      const userText = lastUserLine(sessionMessages)
      if (!userText)
        return
      void client.commitTurn(
        userText, messageText, options.getSessionId?.())
    },

    client,
  }
  return seams
}

function formatMemories(memories: MemoryRecall[]): string {
  if (!memories.length)
    return ''
  const lines = memories.map(m => `- [${m.source}] ${m.text.replace(/\n/g, ' / ')}`)
  return `# Recalled (from her vault)\n${lines.join('\n')}`
}

function lastUserLine(sessionMessages: unknown[]): string | undefined {
  const msgs = Array.isArray(sessionMessages) ? sessionMessages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { from?: string; role?: string; content?: string; text?: string }
    const isUser = m?.from === 'user' || m?.role === 'user'
    const text = m?.content ?? m?.text
    if (isUser && typeof text === 'string' && text.trim())
      return text
  }
  return undefined
}
