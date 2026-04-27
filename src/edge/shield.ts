// (no-op stub — see ./noop.ts for rationale)
import { noopVoid, noopReturnNull } from "./noop.js"
export const installShield = noopVoid
export const uninstallShield = noopVoid
export const __resetShieldForTesting = noopVoid
export const taint = noopReturnNull
