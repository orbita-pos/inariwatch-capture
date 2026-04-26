import type { ErrorEvent } from "./types.js"

/**
 * Payload v2 token budget enforcement.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md §3.1
 *
 * Drop priority (lowest priority dropped first when over budget):
 *   causalGraph
 *   expected
 *   sourceContext.after        (drops `after` lines per frame, keeps `line` + `before`)
 *   precursors[3..]            (keeps top 3)
 *   breadcrumbs[15..]          (keeps last 15)
 *   forensics.closureChains
 *   forensics.locals (frame[1+] first, frame[0] last)
 *   runtimeSnap
 *   hypotheses                 (last to drop — most valuable per token)
 *
 * Token estimate is bytes/4 (cheap; OpenAI tokenizer averages ~3.6 char/token
 * across English+code; bytes/4 is a safe high estimate that errs on the side
 * of dropping more rather than overshooting the model context).
 */

const DEFAULT_BUDGET_TOKENS = 8000

export const V2_FIELD_DROP_PRIORITY = [
  "causalGraph",
  "expected",
  "sourceContext.after",
  "precursors[3..]",
  "breadcrumbs[15..]",
  "forensics.closureChains",
  "forensics.locals",
  "runtimeSnap",
  "hypotheses",
] as const

export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  let bytes: number
  try {
    bytes = JSON.stringify(value).length
  } catch {
    return 0
  }
  return Math.ceil(bytes / 4)
}

export interface BudgetResult {
  /** True if any drops happened */
  dropped: boolean
  /** Names of fields dropped (for telemetry) */
  droppedFields: string[]
  /** Final estimated token count after drops */
  finalTokens: number
}

/**
 * Mutates `event` to fit under `budgetTokens`. Returns drop summary.
 *
 * Always-on policy: the v1 fields (title, body, fingerprint, stack via body)
 * are NEVER touched. Only v2 additive fields drop.
 *
 * The function does NOT write `event.tokensEstimated` — the caller decides
 * whether to attach it. (Writing it from inside makes the function's reported
 * `finalTokens` no longer match `estimateTokens(event)` after return.)
 */
export function applyTokenBudget(
  event: ErrorEvent,
  budgetTokens: number = DEFAULT_BUDGET_TOKENS,
): BudgetResult {
  const droppedFields: string[] = []
  let current = estimateTokens(event)

  if (current <= budgetTokens) {
    return { dropped: false, droppedFields: [], finalTokens: current }
  }

  // 1. causalGraph
  if (current > budgetTokens && event.causalGraph) {
    delete event.causalGraph
    droppedFields.push("causalGraph")
    current = estimateTokens(event)
  }

  // 2. expected
  if (current > budgetTokens && event.expected) {
    delete event.expected
    droppedFields.push("expected")
    current = estimateTokens(event)
  }

  // 3. sourceContext.after — keep `line` + `before`, drop `after`
  if (current > budgetTokens && event.sourceContext?.length) {
    let touched = false
    for (const frame of event.sourceContext) {
      if (frame.after && frame.after.length > 0) {
        frame.after = []
        touched = true
      }
    }
    if (touched) {
      droppedFields.push("sourceContext.after")
      current = estimateTokens(event)
    }
  }

  // 4. precursors[3..] — keep top 3 by deltaPct magnitude
  if (current > budgetTokens && event.precursors && event.precursors.length > 3) {
    event.precursors = [...event.precursors]
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
      .slice(0, 3)
    droppedFields.push("precursors[3..]")
    current = estimateTokens(event)
  }

  // 5. breadcrumbs[15..] — keep last 15 (most recent are most relevant)
  if (current > budgetTokens && event.breadcrumbs && event.breadcrumbs.length > 15) {
    event.breadcrumbs = event.breadcrumbs.slice(-15)
    droppedFields.push("breadcrumbs[15..]")
    current = estimateTokens(event)
  }

  // 6. forensics.closureChains
  if (current > budgetTokens && event.forensics?.closureChains) {
    delete event.forensics.closureChains
    droppedFields.push("forensics.closureChains")
    current = estimateTokens(event)
  }

  // 7. forensics.locals — drop frame[1+] first, then frame[0] last
  if (current > budgetTokens && event.forensics?.locals) {
    const frameKeys = Object.keys(event.forensics.locals).sort((a, b) => Number(a) - Number(b))
    if (frameKeys.length > 1) {
      // Drop everything except frame[0]
      const keep = frameKeys[0]
      const next: Record<string, Record<string, import("./types.js").SerializedValue>> = {}
      if (keep !== undefined && event.forensics.locals[keep]) {
        next[keep] = event.forensics.locals[keep]
      }
      event.forensics.locals = next
      droppedFields.push("forensics.locals[1..]")
      current = estimateTokens(event)
    }
    if (current > budgetTokens) {
      delete event.forensics.locals
      droppedFields.push("forensics.locals")
      current = estimateTokens(event)
    }
    // Drop the forensics container if both children gone
    if (
      event.forensics &&
      !event.forensics.locals &&
      !event.forensics.closureChains &&
      !event.forensics.asyncStack?.length
    ) {
      delete event.forensics
      current = estimateTokens(event)
    }
  }

  // 8. runtimeSnap
  if (current > budgetTokens && event.runtimeSnap) {
    delete event.runtimeSnap
    droppedFields.push("runtimeSnap")
    current = estimateTokens(event)
  }

  // 9. hypotheses (last resort)
  if (current > budgetTokens && event.hypotheses) {
    delete event.hypotheses
    droppedFields.push("hypotheses")
    current = estimateTokens(event)
  }

  return {
    dropped: droppedFields.length > 0,
    droppedFields,
    finalTokens: current,
  }
}
