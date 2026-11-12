export const LOCAL_EMAIL: RegExp;
export interface RefusedIdentity { commit: string; role: "author" | "committer"; email: string }
export function findLocalIdentities(logLines: string[]): RefusedIdentity[];
export function checkRange(repo: string, range: string): RefusedIdentity[];
