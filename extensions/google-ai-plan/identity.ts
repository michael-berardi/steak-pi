import { VERSION } from "@earendil-works/pi-coding-agent";

/**
 * Google identifies apps on this endpoint by `User-Agent` (`<app>/<version>`, PR 12614 README). The OAuth client in
 * client.ts is pi's, approved by Google for pi, so requests identify as the running pi.
 */
export function identityHeaders(): Record<string, string> {
	const platform = typeof process !== "undefined" ? `${process.platform}; node/${process.versions.node}; ${process.arch}` : "browser";
	return { "User-Agent": `pi/${VERSION} (${platform})` };
}
