import type {} from 'pinia-plugin-synced'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, watch } from 'vue'

import { useProviderConfigStore } from '../providers/config'
import { useProviderStore } from '../providers/provider'
import { useConsciousnessSettingsStore } from './consciousness-settings'

export const useConsciousnessStore = defineStore('consciousness', () => {
  const providersStore = useProviderStore()
  const settingsStore = useConsciousnessSettingsStore()
  const providerConfigStore = useProviderConfigStore()

  // Pinia synchronization owns live cross-window state. localStorage remains
  // durable persistence, but storage events must not reflect state back into
  // the store and publish another synchronized snapshot.
  const persistenceOptions = { listenToStorageChanges: false }

  // State
  const activeProvider = useLocalStorageManualReset<string>('settings/consciousness/active-provider', '', persistenceOptions)
  const activeModel = useLocalStorageManualReset<string>('settings/consciousness/active-model', '', persistenceOptions)
  const activeCustomModelName = useLocalStorageManualReset<string>('settings/consciousness/active-custom-model', '', persistenceOptions)
  const expandedDescriptions = refManualReset<Record<string, boolean>>(() => ({}))
  const modelSearchQuery = refManualReset<string>('')

  // Computed properties
  const supportsModelListing = computed(() => {
    return providersStore.supportsModelListing(activeProvider.value)
  })

  const providerModels = computed(() => {
    return providersStore.getModelsForProvider(activeProvider.value)
  })

  const isLoadingActiveProviderModels = computed(() => {
    return providersStore.isLoadingModels[activeProvider.value] || false
  })

  const activeProviderModelError = computed(() => {
    return providersStore.modelLoadError[activeProvider.value] || null
  })

  const activeTemperature = useLocalStorageManualReset<number>(
    'settings/consciousness/active-temperature',
    0.7,
    persistenceOptions,
  )

  const activeTopP = useLocalStorageManualReset<number>(
    'settings/consciousness/active-top-p',
    1.0,
    persistenceOptions,
  )

  const filteredModels = computed(() => {
    if (!modelSearchQuery.value.trim()) {
      return providerModels.value
    }

    const query = modelSearchQuery.value.toLowerCase().trim()
    return providerModels.value.filter(model =>
      model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query)
      || (model.description && model.description.toLowerCase().includes(query)),
    )
  })

  function resetModelSelection() {
    activeModel.reset()
    activeCustomModelName.reset()
    expandedDescriptions.reset()
    modelSearchQuery.reset()
  }

  // A model id belongs to the catalog of the provider it was picked from, so
  // clear the selection whenever the provider changes. This used to live only
  // in the consciousness settings page, so provider changes made elsewhere
  // (onboarding, character cards, provider deletion) kept the previous
  // provider's model and chat requests failed upstream with model_not_found.
  //
  // The watcher is synchronous on purpose: call sites assign the provider
  // first and a new model right after, so a
  // deferred reset would wipe the model they just chose. Synchronous flush
  // makes "set provider, then set model" a safe, ordered operation.
  //
  // Issue #1761: https://github.com/moeru-ai/airi/issues/1761
  watch(activeProvider, (provider, oldProvider) => {
    if (provider === oldProvider)
      return

    activeModel.value = ''
    activeCustomModelName.value = ''
  }, { flush: 'sync' })

  // ── Sovereign local-first chat default (fork) ──────────────────────────
  // This stage is the body of a companion whose chat model runs on this
  // machine (llama.cpp behind the OpenAI-compatible provider on
  // 127.0.0.1:8081). Several paths can leave provider/model EMPTY at send
  // time despite persisted settings: a stale synced tab broadcasting its
  // pre-repair snapshot (pinia-plugin-synced), the sync provider-change
  // watcher above clearing the model, or a fresh profile. Heals in-app,
  // idempotently, filling only EMPTY state — user selections always win.
  // 'default' is a valid model id for llama.cpp: it serves exactly one
  // model and ignores the request's model field.
  function ensureLocalChatDefaults() {
    const existing = providerConfigStore.providers['openai-compatible']
    if (!existing?.config?.baseUrl) {
      providerConfigStore.ensureProvider(
        'openai-compatible',
        'openai-compatible',
        { api: 'chat-completions', baseUrl: 'http://127.0.0.1:8081/v1', apiKey: 'sk-local' },
      )
      providerConfigStore.setProviderStatus('openai-compatible', 'configured')
      providerConfigStore.markProviderAdded('openai-compatible')
    }
    else if (existing.status !== 'configured') {
      providerConfigStore.setProviderStatus('openai-compatible', 'configured')
    }
    if (!activeProvider.value)
      activeProvider.value = 'openai-compatible' // sync watcher clears model; set provider first
    if (!activeModel.value)
      activeModel.value = 'default'
  }
  ensureLocalChatDefaults()

  async function loadModelsForProvider(provider: string) {
    if (providersStore.supportsModelListing(provider)) {
      await providersStore.fetchModelsForProvider(provider)
    }
  }

  async function getModelsForProvider(provider: string) {
    if (providersStore.supportsModelListing(provider)) {
      return providersStore.getModelsForProvider(provider)
    }

    return []
  }

  /** Resolves a provider with the reasoning mode shared by every Consciousness input path. */
  async function getChatProviderInstance(provider: string) {
    return providersStore.getChatProviderInstance(provider, {
      reasoning: settingsStore.reasoning ? 'enabled' : 'disabled',
    })
  }

  const configured = computed(() => {
    return !!activeProvider.value && !!activeModel.value
  })

  function resetState() {
    activeProvider.reset()
    resetModelSelection()
    activeTemperature.reset()
    activeTopP.reset()
    ensureLocalChatDefaults() // a reset must not leave chat unconfigured
  }

  return {
    // State
    configured,
    activeProvider,
    activeModel,
    activeTemperature,
    activeTopP,
    customModelName: activeCustomModelName,
    expandedDescriptions,
    ensureLocalChatDefaults,
    modelSearchQuery,

    // Computed
    supportsModelListing,
    providerModels,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    filteredModels,

    // Actions
    resetModelSelection,
    loadModelsForProvider,
    getModelsForProvider,
    getChatProviderInstance,
    resetState,
  }
}, {
  synced: {
    state: true,
  },
})
