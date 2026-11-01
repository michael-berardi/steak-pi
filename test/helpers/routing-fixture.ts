// Synthetic routing fixture values for tests. Steak Pi no longer ships these choices: they
// are the operator fixture in test/fixtures/routing.json and paid-routes.json (wired by
// vitest.config.ts), re-exported here under the names the former built-ins had so the
// behavioral tests read the same chains, profiles and reviewed routes.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { catalogStartupProviders, registerCatalogExtras, withCatalogExtras } from "../../src/catalog-extras.ts";
import { expertReviewChain, expertReviewModel, multimodalWorkerChain, textWorkerChain, type WorkerRouteStep } from "../../src/model-route-policy.ts";
import { reviewedPaidRoutes, type Route } from "../../src/explicit-paid-route.ts";
import { configuredWorkerProfiles } from "../../src/subagents/model-selection.ts";

type Model = NonNullable<ExtensionContext["model"]>;

export const ROUTING_FIXTURE_PATH = new URL("../fixtures/routing.json", import.meta.url).pathname;
export const PAID_ROUTES_FIXTURE_PATH = new URL("../fixtures/paid-routes.json", import.meta.url).pathname;
export const routingFixture = (): Record<string, unknown> => JSON.parse(readFileSync(ROUTING_FIXTURE_PATH, "utf8"));

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const PAID_INCO_BASE_URL = "https://api.inco.ai/v1";
export const OPENROUTER_DEEPSEEK_ID = "deepseek/deepseek-v4.1-flash-1017:exacto";
export const PAID_ROUTES: readonly Route[] = reviewedPaidRoutes();

export const TERRA_MODEL_ID = "gpt-6.1-terra";
export const TERRA_MODEL_ROUTE = `openai-codex/${TERRA_MODEL_ID}`;
export const TERRA_PROFILE = "steak-pi/gpt-6-1-terra";
export const TERRA_LABEL = "GPT-6.1 Terra";
const terraExtra = (routingFixture().catalogExtras as Array<{ provider: string; models: Array<Record<string, unknown>> }>)[0];
export const TERRA_MODEL = { ...terraExtra.models[0], provider: terraExtra.provider } as unknown as Model;

export const SOL_MODEL_ID = "gpt-6.1-sol";
export const SOL_MODEL_ROUTE = `openai-codex/${SOL_MODEL_ID}`;
export const SOL_PROFILE = "steak-pi/gpt-6-1-sol";
export const FREE_MODEL = "minimax/minimax-m3.1-flash:free";
export const FREE_PROFILE = "steak-pi/minimax-m3-1-flash-free";
export const ROUTINE_GPT_MODEL = "gpt-5.6-luna";
export const DEEPSEEK_OPENROUTER_PROFILE = "steak-pi/deepseek-openrouter";
export const DEEPSEEK_OPENROUTER_ROUTE = `openrouter/${OPENROUTER_DEEPSEEK_ID}`;

export const DEFAULT_TEXT_WORKER_CHAIN: readonly WorkerRouteStep[] = textWorkerChain();
export const DEFAULT_MULTIMODAL_WORKER_CHAIN: readonly WorkerRouteStep[] = multimodalWorkerChain();
export const EXPERT_REVIEW_MODEL: WorkerRouteStep = expertReviewModel()!;
export const EXPERT_TEXT_REVIEW_CHAIN: readonly WorkerRouteStep[] = expertReviewChain(false);
export const EXPERT_MULTIMODAL_REVIEW_CHAIN: readonly WorkerRouteStep[] = expertReviewChain(true);
/** The fixture's worker profiles (the built-in virtual route plus `workerProfiles`). */
export const BUILTIN_WORKER_PROFILES = configuredWorkerProfiles();

export const withTerraCatalog = withCatalogExtras;
export const registerTerraRuntime = registerCatalogExtras;
export const terraStartupProvider = () => catalogStartupProviders()[0];
