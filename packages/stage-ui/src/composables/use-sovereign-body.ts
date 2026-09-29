/**
 * useSovereignBody — wires the Sovereign Core's intents into AIRI's body
 * (the fork-side half of plan §23's "AIRI Body Adapter").
 *
 * Call ONCE from Stage.vue setup:
 *
 *   useSovereignBody({
 *     enqueueEmotion: emotionsQueue.enqueue,
 *     setCurrentMotion: group => (currentMotion.value = { group }),
 *   })
 *
 * The translation itself lives in @sovereign/body-adapter (dependency-free,
 * testable); this composable only binds AIRI surfaces:
 *   - emotion payloads enter AIRI's own emotion queue, which routes them to
 *     whichever renderer is active (Live2D motion groups, VRM expressions,
 *     Spine/tachie/MMD);
 *   - motion intents set the current Live2D motion group directly;
 *   - expression intents additionally try the Live2D expression store as a
 *     fallback for models with named exp3 expressions but no motion groups.
 */
import type { StageEmotionPayload } from '@sovereign/body-adapter'

import { useExpressionStore } from '@proj-airi/stage-ui-live2d/stores/expression-store'
import { createSovereignBodyAdapter } from '@sovereign/body-adapter'
import { onSovereignIntents } from '@sovereign/bridge'
import { onBeforeUnmount } from 'vue'

export interface UseSovereignBodyOptions {
  enqueueEmotion: (payload: StageEmotionPayload) => void
  setCurrentMotion: (group: string) => void
}

export function useSovereignBody(options: UseSovereignBodyOptions) {
  const expressionStore = useExpressionStore()

  const adapter = createSovereignBodyAdapter({
    enqueueEmotion: options.enqueueEmotion,
    setCurrentMotion: options.setCurrentMotion,
    listExpressionNames: () => {
      const result = expressionStore.get()
      const state = result.state
      if (!Array.isArray(state))
        return []
      return state.map(s => (s as { name: string }).name)
    },
    setExpression: (name, value, durationMs) =>
      expressionStore.set(name, value, durationMs),
  })

  const unsubscribe = onSovereignIntents(intents => adapter.handleIntents(intents))
  onBeforeUnmount(unsubscribe)
  return { adapter, unsubscribe }
}
