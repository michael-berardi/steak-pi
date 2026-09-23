/**
 * Steak Pi todo core — thin re-export of the UltraTerm Plan package.
 *
 * The state machine lives in `packages/ultraterm-plan/src/core.ts` and is the
 * exact module the standalone `ut-todo` CLI and every other agent integration
 * run. This file exists so Steak Pi's own imports and tests keep their stable
 * paths; behaviour is defined in one place only.
 */

export * from "../packages/ultraterm-plan/src/core.ts";
