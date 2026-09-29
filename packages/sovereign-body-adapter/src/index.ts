/**
 * @sovereign/body-adapter — plan §23's "AIRI Body Adapter".
 *
 * The mind emits semantic intents (`expression`, `motion`, `gaze`, `say`).
 * This module decides how the BODY expresses them and nothing else:
 *
 *   expression{emotion,intensity} → AIRI EmotionPayload (the stage routes
 *       it per-renderer: Live2D motion groups, VRM expressions, Spine…)
 *       plus an expression-store fallback for Live2D models that ship named
 *       exp3 expressions but no emotion motions.
 *   motion{name}                   → Live2D motion group by name.
 *   gaze{target}                   → reserved (eye-tracking driver, later).
 *
 * Pure, dependency-free, string-typed against AIRI's Emotion *values*
 * (no AIRI imports): the stage-side composable asserts the enum.
 */

export interface SovereignIntent {
  type: string
  payload: Record<string, unknown>
}

/** What AIRI's stage consumes ({ name, intensity }). */
export interface StageEmotionPayload {
  name: string
  intensity: number
}

/** Normalized body actions the adapter emits. */
export type BodyAction
  = | { kind: 'emotion', emotion: StageEmotionPayload }
    | { kind: 'motion', group: string }
    | { kind: 'expression-set', name: string, value: number, durationMs: number }

export interface BodyAdapterDeps {
  /** AIRI stage emotion queue enqueue (drives every renderer). */
  enqueueEmotion: (payload: StageEmotionPayload) => void
  /** Set the current Live2D motion group ({ group }). */
  setCurrentMotion: (group: string) => void
  /** Optional expression-store `set(name, value, duration?)` + names. */
  listExpressionNames?: () => string[]
  setExpression?: (name: string, value: number, durationMs?: number) => unknown
}

/** AIRI Emotion enum values (string) the stage knows how to route. */
const STAGE_EMOTIONS = new Set([
  'happy',
  'sad',
  'angry',
  'think',
  'surprised',
  'awkward',
  'question',
  'curious',
  'neutral',
])

/** Mind vocabulary → stage vocabulary (both string enums at rest). */
const EMOTION_ALIASES: Record<string, string> = {
  surprise: 'surprised',
  thinking: 'think',
  wondering: 'curious',
  confused: 'question',
  shy: 'awkward',
}

/**
 * Named-expression fallback candidates per emotion (exp3 file names vary
 * wildly across models; match generously, order by preference).
 */
const EXPRESSION_CANDIDATES: Record<string, string[]> = {
  happy: ['happy', 'smile', 'joy', 'laugh', 'f01', 'smiling'],
  sad: ['sad', 'cry', 'tears', 'gloomy', 'sorrow'],
  angry: ['angry', 'mad', 'annoyed', 'pout', 'huff'],
  think: ['think', 'thinking', 'serious', 'wink'],
  surprised: ['surprised', 'surprise', 'shock', 'amazed'],
  awkward: ['awkward', 'shy', 'blush', 'embarrassed'],
  question: ['question', 'confused', 'doubt'],
  curious: ['curious', 'wonder', 'interested'],
  neutral: [],
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function normalizeEmotion(name: string): string {
  const key = String(name ?? '').trim().toLowerCase()
  return EMOTION_ALIASES[key] ?? key
}

/** intent → body actions (pure). Unknown intents are ignored, never throw. */
export function intentToBodyActions(intent: SovereignIntent): BodyAction[] {
  const p = intent.payload ?? {}
  if (intent.type === 'expression') {
    const emotion = normalizeEmotion(String(p.emotion ?? 'neutral'))
    const intensity = clamp(Number(p.intensity ?? 0.5), 0, 1)
    const actions: BodyAction[] = []
    if (STAGE_EMOTIONS.has(emotion))
      actions.push({ kind: 'emotion', emotion: { name: emotion, intensity } })
    // expression-store fallback runs only when the model actually exposes a
    // matching named expression (decided at apply-time via deps)
    actions.push({
      kind: 'expression-set',
      name: emotion,
      value: intensity,
      durationMs: Math.round(1200 + intensity * 2800),
    })
    return actions
  }
  if (intent.type === 'motion') {
    const group = String(p.name ?? p.motion ?? '').trim()
    if (group)
      return [{ kind: 'motion', group }]
    return []
  }
  return [] // say / show_text / gaze are the chat & (future) gaze paths
}

export function intentsToBodyActions(intents: SovereignIntent[]): BodyAction[] {
  return intents.flatMap(intentToBodyActions)
}

/** Fuzzy-match an emotion against the model's available expression names. */
export function matchExpressionName(
  emotion: string,
  available: string[],
): string | undefined {
  const norm = normalizeEmotion(emotion)
  const lowered = available.map(n => ({ n, l: n.toLowerCase() }))
  for (const cand of EXPRESSION_CANDIDATES[norm] ?? []) {
    const hit = lowered.find(e => e.l === cand)
      ?? lowered.find(e => e.l.includes(cand))
    if (hit)
      return hit.n
  }
  return undefined
}

export function createSovereignBodyAdapter(deps: BodyAdapterDeps) {
  return {
    handleIntents(intents: SovereignIntent[]) {
      for (const action of intentsToBodyActions(intents)) {
        if (action.kind === 'emotion') {
          deps.enqueueEmotion(action.emotion)
        }
        else if (action.kind === 'motion') {
          deps.setCurrentMotion(action.group)
        }
        else if (action.kind === 'expression-set') {
          if (!deps.listExpressionNames || !deps.setExpression)
            continue
          const names = deps.listExpressionNames()
          const match = matchExpressionName(action.name, names)
          if (match)
            deps.setExpression(match, action.value, action.durationMs)
        }
      }
    },
  }
}
