import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createPersistentBashSession } from "../vendor/pi-dsh-minimal/bash-session.ts";

export const MANAGED_FLAG = "steak-dsh-managed";
export const APPROVED_EXTENSIONS = ["deepseek-harness.ts", "model-route-policy.ts", "session-title.ts", "statusline.ts", "todo.ts", "ultraterm-inbox.ts", "ultraterm-subagents.ts", "ultraterm-ui.ts", "verify-after-edit.ts", "ultracompress/index.ts", "skill-catalog-lite/index.ts"];
const fail = (message: string): never => { throw new Error(`steak-pi-dsh preflight: ${message}. Use ordinary pi with your guards, or explicitly review/remove the unsupported configuration; nothing was launched.`); };
const json = (path: string): any => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
export function resolveSystemBash(env: NodeJS.ProcessEnv, cwd: string): string {
  const shell = env.SHELL ?? "";
  const candidate = /(^|[\\/])bash$/.test(shell) ? shell : (env.PATH ?? "/usr/bin:/bin").split(":").map(p => resolve(cwd, p || ".", "bash")).find(p => existsSync(p));
  if (!candidate || !existsSync(candidate)) return fail("system bash is unavailable");
  const executable = realpathSync(candidate);
  const allowed = ["/bin/bash", "/usr/bin/bash"].filter(p => existsSync(p)).map(p => realpathSync(p));
  if (!allowed.includes(executable)) return fail("custom PATH/SHELL bash executable is unsupported");
  return executable;
}
function checkSettings(value: unknown, location: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (/shell|commandPrefix|spawnHook|operations|exposeSessionEnvironment/i.test(key) && nested !== undefined) fail(`unsupported setting ${key} in ${location}`);
    checkSettings(nested, location);
  }
}
export function preflightPrimary(root: string, cwd: string, agentDir: string, args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  root = realpathSync(root);
  if (process.platform === "win32") fail("POSIX bash is required");
  for (const key of ["BASH_ENV", "ENV", "NODE_OPTIONS", "PI_PACKAGE_DIR"]) if (env[key]) fail(`${key} is unsupported`);
  if (Object.keys(env).some(k => k.startsWith("BASH_FUNC_"))) fail("exported bash function hooks are unsupported");
  if (env.SHELL?.endsWith("/bash") && env.SHELL !== "/bin/bash" && env.SHELL !== "/usr/bin/bash") fail("custom SHELL bash executable is unsupported");
  resolveSystemBash(env, cwd);
  const manifest = json(join(root, "package.json"));
  const version = manifest.version;
  const expectedDiscovery = ["./extensions", "./extensions/ultracompress/index.ts", "./extensions/skill-catalog-lite/index.ts"];
  if (manifest.name !== "steak-pi" || !Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length !== expectedDiscovery.length ||
    new Set(manifest.pi.extensions).size !== expectedDiscovery.length || manifest.pi.extensions.some((p: unknown) => !expectedDiscovery.includes(p as string))) fail("unreviewed package extension manifest");
  const approved = APPROVED_EXTENSIONS.map(p => realpathSync(join(root, "extensions", p)));
  const allowed = new Set([...approved, realpathSync(join(root, "extensions")), ...["ultracompress", "skill-catalog-lite"].map(p => realpathSync(join(root, "extensions", p)))]);
  const admitPath = (p: unknown, base: string) => {
    if (typeof p !== "string" || p.startsWith("!") || !existsSync(resolve(base, p)) || !allowed.has(realpathSync(resolve(base, p)))) fail(`unapproved extension ${String(p)}`);
  };
  for (const base of [agentDir, join(cwd, ".pi")]) {
    const settings = json(join(base, "settings.json"));
    checkSettings(settings, base);
    for (const p of settings.extensions ?? []) admitPath(p, base);
    const discovery = join(base, "extensions");
    if (existsSync(discovery)) for (const name of readdirSync(discovery)) admitPath(join(discovery, name), base);
    for (const entry of settings.packages ?? []) {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof entry === "object" && Object.keys(entry).some(k => k !== "source")) fail("package resource filters are not admitted");
      if (typeof source !== "string") fail("invalid package source");
      let location = resolve(base, source);
      if (source === `git:github.com/michael-berardi/steak-pi@v${version}`) location = join(base, "git/github.com/michael-berardi/steak-pi");
      if (!existsSync(location) || realpathSync(location) !== root) fail(`extra or noncanonical package ${source}; launch the entrypoint from the configured Steak package`);
    }
  }
  // Explicit files must match the complete first-party discovery surface.
  for (const dir of ["", "ultracompress", "skill-catalog-lite"]) if (existsSync(join(root, "extensions", dir, "package.json"))) fail("nested extension package manifests are not admitted");
  for (const name of readdirSync(join(root, "extensions"))) {
    if (/\.([cm]?[tj]sx?)$/.test(name) && !APPROVED_EXTENSIONS.includes(name)) fail(`unreviewed first-party extension ${name}`);
    if (!["ultracompress", "skill-catalog-lite"].includes(name) &&
      ["index.ts", "index.js", "index.mjs", "index.cjs", "package.json"].some(entry => existsSync(join(root, "extensions", name, entry)))) fail(`unreviewed first-party extension directory ${name}`);
  }
  const flags = new Set(["--version", "--print", "-p", "--no-session", "--continue", "-c", "--resume", "-r"]);
  const normalizedArgs = [...args];
  const values: Record<string, readonly string[] | undefined> = { "--provider": ["opencode-go"], "--model": ["deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash"], "--session": undefined, "--session-dir": undefined, "--thinking": ["off", "minimal", "low", "medium", "high", "xhigh"], "--mode": ["text", "json", "rpc"] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || flags.has(arg)) continue;
    if (Object.hasOwn(values, arg)) {
      const value = args[++i];
      if (!value || value.startsWith("-") || (values[arg] && !values[arg]!.includes(value))) fail(`invalid ${arg} value`);
      if (arg === "--model") normalizedArgs[i] = "deepseek-v4.1-flash";
    } else fail(`CLI option ${arg} is not admitted; resource/tool/provider overrides are forbidden`);
  }
  return ["--no-extensions", ...approved.flatMap(p => ["-e", p]), "--skill", join(root, "skills"), `--${MANAGED_FLAG}`, "--provider", "opencode-go", "--model", "deepseek-v4.1-flash", "--thinking", "high", ...normalizedArgs];
}

/** No SDK is imported at launcher time. Check the actual CLI package before spawn. */
export function resolveNativePi(path: string, sdkRoot?: string, nativeCli?: string): string {
  const pin = !nativeCli && sdkRoot ? json(join(sdkRoot, "package.json")) : undefined;
  const executable = nativeCli ?? (sdkRoot && typeof pin?.bin?.pi === "string" ? join(sdkRoot, pin.bin.pi) : sdkRoot ? undefined : path.split(":").map(p => join(p, "pi")).find(p => existsSync(p)));
  if (!executable || !existsSync(executable)) return fail("native pi is unavailable; provide a Pi 0.86.0 SDK root or native PATH entry");
  const cli = realpathSync(executable);
  const roots = [dirname(dirname(cli)), dirname(dirname(dirname(cli)))];
  const root = roots.find(p => {
    const pkg = json(join(p, "package.json"));
    return pkg.name === "@earendil-works/pi-coding-agent" && pkg.version === "0.86.0" &&
      typeof pkg.bin?.pi === "string" && realpathSync(join(p, pkg.bin.pi)) === cli;
  });
  if (!root || ![join(root, "dist/cli.js"), join(root, "dist/bundle/cli.js")].includes(cli)) fail("pi must be the published native SDK 0.86.0 CLI, not a wrapper");
  return cli;
}

export function createPrimaryShell(cwd: string, factory = (path: string) => createPersistentBashSession(path, resolveSystemBash(process.env, path))) {
  const previousMetadata = new Set<string>();
  let shell: ReturnType<typeof factory> | undefined;
  let poisoned = false;
  const dispose = async () => {
    if (poisoned) throw new Error("Persistent bash cleanup failed; restart the managed session");
    const previous = shell; shell = undefined;
    try { await previous?.dispose(); } catch (error) { poisoned = true; throw error; }
  };
  const operations: BashOperations = { async exec(command, _cwd, options) {
    if (poisoned) throw new Error("Persistent bash cleanup failed; restart the managed session");
    shell ??= factory(cwd);
    // Native createBashToolDefinition supplies session PI_* metadata. Preserve it
    // without resetting user exports/cwd/functions on every persistent call.
    const metadata = Object.entries(options.env ?? {}).filter(([k, v]) => v !== undefined && (previousMetadata.has(k) || k.startsWith("PI_") || v !== process.env[k]));
    if (metadata.some(([k]) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(k))) throw new Error("Unsupported shell environment key");
    const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
    const present = new Set(metadata.map(([key]) => key));
    const unset = [...new Set([...previousMetadata, "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"])].filter(k => !present.has(k));
    previousMetadata.clear();
    for (const key of present) previousMetadata.add(key);
    const prefix = [...(unset.length ? [`unset ${unset.join(" ")}`] : []), ...metadata.map(([k,v]) => `export ${k}=${quote(v!)}`)].join("\n");
    let exitCode: number | null = null;
    const output = await shell.exec(`${prefix}\n${command}`, { signal: options.signal, timeoutMs: (options.timeout ?? 120) * 1000, onExitCode: code => { exitCode = code; } });
    options.onData(Buffer.from(output));
    if (exitCode === null) throw new Error(`Persistent bash did not complete normally: ${output}`);
    return { exitCode };
  } };
  return { operations, dispose };
}
