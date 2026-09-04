import { runSyntheticBenchmark } from "./executor.ts";
import { USAP_BENCHMARK_MANIFEST } from "./manifest.ts";

// Local fixture replay only. This module contains no provider client or network path.
process.stdout.write(`${JSON.stringify(runSyntheticBenchmark(USAP_BENCHMARK_MANIFEST), null, 2)}\n`);
