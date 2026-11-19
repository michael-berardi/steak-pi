/**
 * The harness adapter: local mode looks for a LoRA adapter trained to work inside this harness on the exact model the
 * operator added, and applies it. Nothing ships with Steak Pi and nothing is bundled: the adapter is found on the
 * Hugging Face hub from what the model file itself says, fetched the first time it is needed, and cached under
 * `~/.pi/agent/local/adapters/`.
 *
 * How it decides, from evidence only (no model name, repo or publisher is written in this file):
 *  1. Which exact hub model this file is (`resolveBase`): from the hub repo it was added from, or from the file's own
 *     name checked against the base it declares. A model that says it is a fine-tune, or calls itself something other
 *     than the base it declares, gets none: an adapter only behaves as trained on the exact model it was trained on,
 *     and a fine-tune has the same shapes. A fine-tune that kept its base's name cannot be told apart; that limit is
 *     documented.
 *  2. The hub's index lists adapters trained on exactly that repo with the harness tag (`base_model:adapter:<base>` +
 *     `pi`). The candidate is the most downloaded one; its llama.cpp (GGUF) form must come from the same publisher.
 *  3. Trust is the operator's: an adapter changes how the model behaves, and the model's tool calls run with the
 *     operator's permissions, while anyone can publish on the hub. A publisher is used only once the operator has
 *     trusted it (`trusted-publishers.json`, empty unless the operator adds to it): an interactive `add` shows the
 *     publisher, repo, commit and downloads and asks once; anything else names the adapter and how to trust it, and
 *     runs the model plain. Download counts are shown, never used as trust.
 *  4. The file is pinned to the commit it was found at, checked against the SHA-256 the hub publishes for that commit
 *     (that proves the bytes are what the publisher published, not who the publisher is) and matched tensor by tensor
 *     against the model (`adapter.ts`).
 *
 * The decision is made at `add` (and by `local adapter <id>` for a model added before) and recorded in the launch
 * profile, so a start never waits on the hub. `--no-adapter` (or `"harnessAdapter": "off"` in the profile) opts out.
 */
import { join } from "node:path";
import type { GgufInfo } from "./gguf.ts";
import { adapterFromHub, type AdapterRef, type Download, type ListFetch } from "./adapter.ts";
import { LocalError } from "./errors.ts";
import { readJson, writeAtomic } from "./store.ts";

/** The hub tag adapters trained for this harness carry. */
export const HARNESS_TAG = "pi";
const REPO = /^[\w.-]+\/[\w.-]+$/;

interface HubModel { id: string; author?: string; sha?: string; downloads?: number; tags?: string[]; gguf?: unknown; cardData?: { base_model?: string | string[] } }

export interface HarnessAdapterResult {
  /** The adapter to apply, when one was found and checked. */
  ref?: AdapterRef;
  /** What was decided and why, one line each, for the `add` output. */
  lines: string[];
  /** Thinking the adapter was trained and evaluated with, when its card says so. */
  trained?: { thinking: "off" };
}

/** Ask the operator once whether to trust a publisher; undefined when nobody can be asked (no terminal). */
export type TrustPrompt = (question: string) => Promise<boolean>;

const trustPath = (dir: string): string => join(dir, "trusted-publishers.json");
interface TrustFile { publishers?: string[] }
/** Publishers the operator trusts for harness adapters. Empty unless the operator added one. */
export function trustedPublishers(dir: string): Set<string> {
  const file = readJson<TrustFile>(trustPath(dir));
  return new Set((Array.isArray(file?.publishers) ? file.publishers : []).filter((name): name is string => typeof name === "string" && /^[\w.-]+$/.test(name)).map((name) => name.toLowerCase()));
}
export function trustPublisher(dir: string, publisher: string): void {
  const all = trustedPublishers(dir);
  all.add(publisher.toLowerCase());
  writeAtomic(trustPath(dir), `${JSON.stringify({ publishers: [...all].sort() }, null, 2)}\n`);
}
const owner = (repo: string): string => repo.split("/")[0].toLowerCase();

const hfHeaders = (): Record<string, string> => process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};

async function getJson<T>(list: ListFetch, url: string): Promise<T> {
  const response = await list(url, { headers: hfHeaders(), signal: AbortSignal.timeout(20_000) }).catch((error: Error) => {
    throw new LocalError("hf-unreachable", `cannot reach Hugging Face (${error.message})`);
  });
  if (!response.ok) throw new LocalError("hf-unreachable", `Hugging Face answered ${response.status} for ${url}`);
  return (await response.json()) as T;
}

const norm = (text: string): string => text.trim().toLowerCase().replace(/[\s_]+/g, "-");
const repoName = (repo: string): string => norm(repo.split("/")[1] ?? "");

/** The names the model file calls itself by, normalised: `general.name`, and `basename` with and without its size. */
export function identityNames(info: GgufInfo): Set<string> {
  const names = new Set<string>();
  if (info.name) names.add(norm(info.name));
  if (info.basename) {
    names.add(norm(info.basename));
    if (info.sizeLabel) names.add(norm(`${info.basename}-${info.sizeLabel}`));
  }
  return names;
}

/**
 * The exact hub model this file is a copy (or quantization) of, or why there is none. Evidence, in order:
 *  - added from the hub: that repo's own `base_model:quantized:<repo>` tag;
 *  - a base the file declares (`general.base_model.N.repo_url`) whose name is the file's own name;
 *  - `<declared organization>/<the file's own name>`, when that repo exists;
 *  - with no declaration, none: a name search could pick another account's re-upload of the same name.
 * A file that says it is a fine-tune, or that calls itself something other than the base it declares (a fine-tune
 * that kept its parent's declaration), gets none: shapes cannot tell a fine-tune from its base.
 */
export async function resolveBase(info: GgufInfo, source: { kind: "file" } | { kind: "hf"; spec: string }, list: ListFetch): Promise<{ repo?: string; why: string }> {
  // llama.cpp's converter writes the last name part as `finetune` ("Instruct", "Chat"): that names the release, not a
  // fine-tune of it. Any other value is a fine-tune.
  const release = info.finetune && /^(instruct|chat|it|base)$/i.test(info.finetune);
  if (info.finetune && !release) return { why: `the model file says it is a fine-tune (${info.finetune}); a harness adapter is trained on an exact base model` };
  let names = identityNames(info);
  if (release) {
    // An Instruct (or Chat) release is its own model: only names that carry the release word identify it, so the
    // pretrained base it declares (named without that word) is never taken for it.
    const word = norm(info.finetune!);
    const withWord = new Set([...names].filter((name) => name.split("-").includes(word)));
    if (info.basename) {
      withWord.add(norm(`${info.basename}-${info.finetune}`));
      if (info.sizeLabel) withWord.add(norm(`${info.basename}-${info.sizeLabel}-${info.finetune}`));
    }
    names = withWord;
  }
  if (source.kind === "hf") {
    const repo = source.spec.split(":")[0];
    const hub = await getJson<HubModel>(list, `https://huggingface.co/api/models/${repo}`);
    const quantized = (hub.tags ?? []).filter((tag) => tag.startsWith("base_model:quantized:")).map((tag) => tag.slice("base_model:quantized:".length));
    // The repo's own tag says what it quantizes; the file's own name must agree, so a mistagged fine-tune is not taken for its base.
    if (quantized.length === 1 && REPO.test(quantized[0]) && names.has(repoName(quantized[0]))) return { repo: quantized[0], why: `${repo} is tagged as a quantization of ${quantized[0]}, and the file's name agrees` };
    if ((hub.tags ?? []).some((tag) => /^base_model:(?:finetune|merge|adapter):/.test(tag))) return { why: `${repo} is a fine-tune, merge or adapter on the hub, not a copy of an original model` };
  }
  if (!names.size) return { why: "the model file does not say what model it is" };
  const declared = (info.baseModelRepos ?? []).filter((repo) => REPO.test(repo));
  const same = declared.find((repo) => names.has(repoName(repo)));
  if (same) return { repo: same, why: `the file is ${same} (its name and its declared base agree)` };
  for (const org of new Set(info.baseModelOrgs ?? [])) {
    for (const name of names) {
      const repo = `${org}/${name}`;
      if (!REPO.test(repo)) continue;
      const hub = await getJson<HubModel>(list, `https://huggingface.co/api/models/${repo}`).catch(() => undefined);
      if (hub?.id && names.has(repoName(hub.id))) return { repo: hub.id, why: `the file is ${hub.id} (its name, from the organization it declares)` };
    }
  }
  if (declared.length) return { why: `the file calls itself ${[...names][0]} but declares ${declared.join(", ")} as its base: a model derived from that base, not the base itself` };
  // No declaration: a name search could pick another account's re-upload of the same name, so it is not used.
  return { why: `the model file does not say which hub model it is (no base model declared); add it from the hub as owner/repo:quant so local mode can tell` };
}

/**
 * Find, fetch, verify and check the harness adapter for this model. Never throws for a model that simply has none:
 * every outcome is a line; only `strict` (an explicit `local adapter` request) turns a failure into a refusal.
 */
export async function findHarnessAdapter(info: GgufInfo, source: { kind: "file" } | { kind: "hf"; spec: string }, dir: string, deps: { list?: ListFetch; download?: Download; progress?: (text: string) => void; strict?: boolean; ask?: TrustPrompt; trust?: boolean | string; modelId?: string } = {}): Promise<HarnessAdapterResult> {
  const list = deps.list ?? (fetch as unknown as ListFetch);
  const skip = (why: string): HarnessAdapterResult => {
    if (deps.strict) throw new LocalError("no-harness-adapter", why);
    return { lines: [`adapter   none: ${why}`] };
  };
  try {
    const base = await resolveBase(info, source, list);
    if (!base.repo) return skip(base.why);
    const query = (filters: string[]) => `https://huggingface.co/api/models?${filters.map((filter) => `filter=${encodeURIComponent(filter)}`).join("&")}&sort=downloads&limit=20`;
    const adapters = (await getJson<HubModel[]>(list, query([`base_model:adapter:${base.repo}`, HARNESS_TAG]))).filter((model) => REPO.test(model.id));
    if (!adapters.length) return skip(`no adapter trained for this harness is listed for ${base.repo}`);
    // One candidate: the most downloaded. A failing candidate never hands over to another publisher's.
    const adapter = adapters[0];
    const publisher = owner(adapter.id);
    const ggufs = (await getJson<HubModel[]>(list, query([`base_model:adapter:${adapter.id}`, "gguf"])))
      .filter((model) => REPO.test(model.id) && (model.tags ?? []).includes(HARNESS_TAG) && owner(model.id) === publisher);
    const gguf = (adapter.tags ?? []).includes("gguf") ? adapter : ggufs[0];
    if (!gguf) return skip(`${adapter.id} has no llama.cpp (GGUF) form from the same publisher`);
    const detail = await getJson<HubModel>(list, `https://huggingface.co/api/models/${gguf.id}`);
    const revision = typeof detail.sha === "string" && /^[0-9a-f]{40}$/.test(detail.sha) ? detail.sha : undefined;
    if (!revision) return skip(`${gguf.id} has no commit id on the hub, so the file cannot be pinned`);
    const card = `${gguf.id} at commit ${revision.slice(0, 12)} (${detail.downloads ?? adapter.downloads ?? 0} downloads), trained for this harness on ${base.repo}`;
    if (!trustedPublishers(dir).has(publisher)) {
      // `--trust <publisher>` trusts exactly the one named (so a different top candidate found later is never trusted by
      // accident); a bare `--trust` trusts whoever is the candidate now, which the output names.
      if (typeof deps.trust === "string" && deps.trust.toLowerCase() !== publisher) {
        const why = `the harness adapter for ${base.repo} is now ${card}, from "${publisher}", not "${deps.trust}"; nothing was trusted. Check it, then trust it with: --trust ${publisher}`;
        if (deps.strict) throw new LocalError("untrusted-publisher", why);
        return { lines: [`adapter   ${why}`] };
      }
      const asked = deps.trust ? true : deps.ask ? await deps.ask(`Harness adapter for ${base.repo}: ${card}.\nIt changes how the model behaves, and the model's tool calls run with your permissions. Trust adapters from "${publisher}"?`) : undefined;
      if (!asked) {
        const why = `found ${card}; not applied because "${publisher}" is not a trusted publisher. Trust it and apply it with: steak-pi local adapter ${deps.modelId ?? "<id>"} --trust ${publisher}`;
        if (deps.strict) throw new LocalError("untrusted-publisher", why);
        return { lines: [`adapter   ${why}`] };
      }
      trustPublisher(dir, publisher);
    }
    deps.progress?.(`local mode: fetching the harness adapter ${gguf.id}`);
    let found: Awaited<ReturnType<typeof adapterFromHub>>;
    try { found = await adapterFromHub(gguf.id, dir, info, 1, { list, download: deps.download, progress: deps.progress, revision }); }
    catch (error) { if (!(error instanceof LocalError)) throw error; return skip(`${gguf.id} did not check out (${error.code}: ${error.message})`); }
    const adapterDetail = adapter.id === gguf.id ? detail : await getJson<HubModel>(list, `https://huggingface.co/api/models/${adapter.id}`).catch(() => undefined);
    const thinkingOff = await trainedWithoutThinking(list, [[adapter.id, adapterDetail?.sha], [gguf.id, revision]]);
    return {
      ref: found.ref,
      ...(thinkingOff ? { trained: { thinking: "off" as const } } : {}),
      lines: [
        `adapter   ${card}; publisher "${publisher}" is trusted; ${base.why}`,
        ...found.lines,
        ...(thinkingOff ? ["thinking  off by default: the adapter's card says it was trained and measured with thinking off; /thinking turns it on"] : []),
      ],
    };
  } catch (error) {
    if (error instanceof LocalError && !deps.strict) return { lines: [`adapter   not checked: ${error.message}; the model runs without it (try again with: steak-pi local adapter <id>)`] };
    throw error;
  }
}

/** True when the adapter's model card says it was trained or evaluated with thinking off. Read, never assumed. */
async function trainedWithoutThinking(list: ListFetch, repos: Array<[string, string | undefined]>): Promise<boolean> {
  for (const [repo, sha] of repos) {
    const rev = sha && /^[0-9a-f]{40}$/.test(sha) ? sha : "main";
    const response = await list(`https://huggingface.co/${repo}/raw/${rev}/README.md`, { headers: hfHeaders(), signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    if (!response?.ok) continue;
    const text = typeof (response as { text?: () => Promise<string> }).text === "function" ? await (response as unknown as { text(): Promise<string> }).text() : String(await response.json().catch(() => ""));
    // The card's own statement of how it was trained or measured, or the serving flag it documents. A sentence that
    // weighs both ("with or without thinking") does not count.
    const says = /(?:^|[^\w])thinking off(?![\w-])|"enable_thinking"\s*:\s*false/i.test(text);
    if (says && !/with or without thinking|thinking on or off|thinking off or on/i.test(text)) return true;
  }
  return false;
}
