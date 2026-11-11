// `steak-pi routing check [file]`: validate a routing.json with the exact parser every Pi turn uses, so a writer can
// refuse a bad file before it lands. 2026-11-08: a retune appended evidence to taskClasses notes (727 > 400 characters)
// and every pane failed on its next turn. Harness-qualified steak-dsh entries are additionally resolved against the
// same model registry Pi uses (offline, no network): an unknown inner model is a named error.
import { readFileSync } from "node:fs";
import { DSH_ROUTE_PREFIX, parseRoutingConfig, ROUTING_CONFIG_ENV, routeKey, routingConfigPath } from "./routing-config.ts";
import { dshRouteModel } from "./subagents/dsh-routes.ts";

const path = process.argv[2] ?? routingConfigPath();
try {
  const config = parseRoutingConfig(JSON.parse(readFileSync(path, "utf8")));
  const dshRoutes = new Set<string>();
  for (const chain of [config.textWorkerChain, config.multimodalWorkerChain]) {
    for (const step of chain ?? []) if (step.harness === "steak-dsh") dshRoutes.add(routeKey(step));
  }
  for (const taskClass of Object.values(config.taskClasses ?? {})) {
    for (const entry of taskClass.chain) if (entry.startsWith(DSH_ROUTE_PREFIX)) dshRoutes.add(entry);
  }
  if (dshRoutes.size > 0) {
    // The checked file is the operator config for this validation, so its catalogExtras register too.
    process.env[ROUTING_CONFIG_ENV] = path;
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { registerCatalogExtras } = await import("./catalog-extras.ts");
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    registerCatalogExtras(runtime);
    for (const route of dshRoutes) {
      const inner = dshRouteModel(route);
      if (inner === undefined) throw new Error(`steak-dsh route ${route} must name an inner provider/model route (steak-dsh/<provider>/<model-id>)`);
      if (runtime.getModel(inner.provider, inner.id) === undefined) {
        throw new Error(`steak-dsh route ${route}: inner model ${inner.provider}/${inner.id} is not in the Pi model registry; name an exact model the registry serves (a native provider catalog, models.json, or catalogExtras in the same file)`);
      }
    }
  }
  console.log(`ok ${path}`);
} catch (error) {
  console.error(`steak-pi routing check: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
