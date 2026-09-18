/**
 * Sovereign build profile gate (plan §25 of aiyuri/plan.md).
 *
 * BUILD_PROFILE=sovereign must make analytics / auth / cloud sync *absent*,
 * not disabled. This constant is the compile-time seam:
 *  - define BUILD_PROFILE via Vite `define` (`__SOVEREIGN__`-style) or env,
 *  - call sites below dead-code-eliminate when it is set,
 *  - the full dependency exclusion (@openpanel/web, @opentelemetry/*,
 *    better-auth, drizzle cloud) is tracked in aiyuri docs/M0-M1-changelist.md
 *    and lands with the profile CI build.
 *
 * The `sovereign` branch ships the gate; shipping the stripped bundle is M0's
 * release-audit step.
 */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

export const SOVEREIGN_PROFILE = env.BUILD_PROFILE === 'sovereign'
