// Entry point for `steak-pi local` (bin/steak-pi runs this with node) and for the detached supervisor.
import { main } from "./cli.ts";

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
  console.error(`steak-pi local: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
