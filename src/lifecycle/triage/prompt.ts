/**
 * prompt.ts — versioned agent prompt (plan D5). Task 3 adds SYSTEM_PROMPT
 * here. PROMPT_VERSION is exported now (Task 2) because record_triage
 * prefixes every recorded note with `[by agent-triage v<PROMPT_VERSION>]` —
 * bumping this number is how a future prompt revision becomes distinguishable
 * in notes already written to the store.
 */

export const PROMPT_VERSION = 1;
