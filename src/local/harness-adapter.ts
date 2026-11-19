/**
 * The harness adapter: local mode looks for a LoRA adapter trained to work inside this harness on the exact base model
 * the operator added, and applies it. Nothing ships with Steak Pi and nothing is bundled: the adapter is found on the
 * Hugging Face hub from what the model file itself says, fetched the first time it is needed, verified against the
 * hub's published SHA-256, matched tensor by tensor against the model, and cached under `~/.pi/agent/local/adapters/`.
 *
 * How it decides, from evidence only (no model name, repo or publisher is written in this file):
 *  1. Which exact hub model this file is (`resolveBase`): from the hub repo it was added from, or from the file's own
 *     name checked against the base it declares. A fine-tune gets no adapter: an adapter only behaves as trained on the
 *     exact base it was trained on, and a fine-tune of the same architecture has the same shapes, so shapes alone
 *     cannot tell.
 *  2. The hub's own index lists adapters trained on exactly that repo and carrying the harness tag
 *     (`base_model:adapter:<base>` plus `pi`). That repo may itself be an instruct tune of a pretrained model; what
 *     matters is that the adapter names it, and that this file is it (step 1), not a further fine-tune of it.
 *     The most downloaded one is the candidate; the GGUF form of it is the repo that names it as its base.
 *  3. Its GGUF file is downloaded once, checked against the published SHA-256 and matched against the model's tensors
 *     (`adapter.ts`). Anything that does not check out is skipped with its cause, and the model runs plain.
 *
 * The decision is made at `add` (and by `local adapter <id>` for a model added before) and recorded in the launch
 * profile, so a start never waits on the hub. `--no-adapter` (or `"harnessAdapter": "off"` in the profile) opts out.
 */
import type { GgufInfo } from "./gguf.ts";
import { adapterFromHub, type AdapterRef, type Download, type ListFetch } from "./adapter.ts";
import { LocalError } from "./errors.ts";

/** The hub tag adapters trained for this harness carry. */
export const HARNESS_TAG = "pi";
const REPO = /^[\w.-]+\/[\w.-]+$/;

interface HubModel { id: string; downloads?: number; tags?: string[]; gguf?: unknown; cardData?: { base_model?: string | string[] } }

export interface HarnessAdapterResult {
  /** The adapter to apply, when one was found and checked. */
  ref?: AdapterRef;
  /** What was decided and why, one line each, for the `add` output. */
  lines: string[];
  /** Sampling and thinking the adapter was trained with, when its card says (applied to the model entry). */
  trained?: { thinking: "off" | "on" };
}

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
 *  - with no declaration, the most downloaded hub model whose name is exactly the file's own name.
 * A file that says it is a fine-tune, or that calls itself something other than the base it declares (a fine-tune
 * that kept its parent's declaration), gets none: shapes cannot tell a fine-tune from its base.
 */
export async function resolveBase(info: GgufInfo, source: { kind: "file" } | { kind: "hf"; spec: string }, list: ListFetch): Promise<{ repo?: string; why: string }> {
  if (info.finetune) return { why: `the model file says it is a fine-tune (${info.finetune}); a harness adapter is trained on an exact base model` };
  const names = identityNames(info);
  if (source.kind === "hf") {
    const repo = source.spec.split(":")[0];
    const hub = await getJson<HubModel>(list, `https://huggingface.co/api/models/${repo}`);
    const quantized = (hub.tags ?? []).filter((tag) => tag.startsWith("base_model:quantized:")).map((tag) => tag.slice("base_model:quantized:".length));
    if (quantized.length === 1 && REPO.test(quantized[0])) return { repo: quantized[0], why: `${repo} is tagged as a quantization of ${quantized[0]}` };
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
  for (const name of names) {
    const found = await getJson<HubModel[]>(list, `https://huggingface.co/api/models?search=${encodeURIComponent(name)}&sort=downloads&limit=20`);
    const exact = found.filter((model) => REPO.test(model.id) && repoName(model.id) === name && !(model.tags ?? []).some((tag) => tag.startsWith("base_model:")));
    if (exact.length) return { repo: exact[0].id, why: `the file is named ${name}, and ${exact[0].id} is the most downloaded original model of that name` };
  }
  return { why: `no original hub model is named ${[...names].join(" or ")}` };
}

/**
 * Find, fetch, verify and check the harness adapter for this model. Never throws for a model that simply has none:
 * every outcome is a line; only `strict` (an explicit `local adapter` request) turns a failure into a refusal.
 */
export async function findHarnessAdapter(info: GgufInfo, source: { kind: "file" } | { kind: "hf"; spec: string }, dir: string, deps: { list?: ListFetch; download?: Download; progress?: (text: string) => void; strict?: boolean } = {}): Promise<HarnessAdapterResult> {
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
    const tried: string[] = [];
    for (const adapter of adapters.slice(0, 3)) {
      // The llama.cpp form: a GGUF repo that names this adapter as its base and carries the harness tag.
      const ggufs = (await getJson<HubModel[]>(list, query([`base_model:adapter:${adapter.id}`, "gguf"])))
        .filter((model) => REPO.test(model.id) && (model.tags ?? []).includes(HARNESS_TAG));
      const gguf = (adapter.tags ?? []).includes("gguf") ? adapter : ggufs[0];
      if (!gguf) { tried.push(`${adapter.id} (no GGUF form)`); continue; }
      try {
        deps.progress?.(`local mode: ${base.repo} has a harness adapter (${adapter.id}); fetching it`);
        const found = await adapterFromHub(gguf.id, dir, info, 1, { list, download: deps.download, progress: deps.progress });
        return {
          ref: found.ref,
          trained: { thinking: "off" },
          lines: [
            `adapter   ${adapter.id}, trained for this harness on ${base.repo}; ${base.why}`,
            ...found.lines,
            "thinking  off by default: the adapter was trained without thinking; /thinking turns it on",
          ],
        };
      } catch (error) {
        if (!(error instanceof LocalError)) throw error;
        tried.push(`${gguf.id} (${error.code}: ${error.message})`);
      }
    }
    return skip(`the harness adapters for ${base.repo} did not check out: ${tried.join("; ")}`);
  } catch (error) {
    if (error instanceof LocalError && !deps.strict) return { lines: [`adapter   not checked: ${error.message}; the model runs without it (try again with: steak-pi local adapter <id>)`] };
    throw error;
  }
}
