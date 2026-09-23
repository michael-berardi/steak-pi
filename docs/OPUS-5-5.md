# Claude Opus 5.5 — staged, credential-free

Official model reference: https://platform.claude.com/docs/en/models/opus-5-5/overview
(parent-verified). Model ID `claude-opus-5-5`: text/images, 1M context,
128K output, $4 input / $20 output per million tokens. Adaptive thinking is
always on; effort controls its depth. This legacy Pi fragment verifies `high`.
The UltraTerm 2.3.5 expert default is instead the official Claude Code CLI at
`xhigh`, through USAP 1.3. This fragment is retained unchanged and inactive.

## Opt-in configuration (Pi 0.87.0)

`opus-5-5.models.json` is a **merge fragment**, not a replacement for your
models.json. Merge only its model entry by ID into `providers.anthropic.models`,
retaining every existing provider, model, override, and credential configuration.
The model has its own first-party `https://api.anthropic.com` endpoint; no provider
endpoint, authentication mechanism, OAuth registration or other model is
replaced. Do not apply this legacy fragment over a newer built-in definition:
Pi 0.87.1 already includes Opus 5.5, with additional native effort metadata.
An explicit merge by ID would replace that target's fields. Inspect existing Anthropic proxy/header/auth overrides before enabling:
they remain user-owned and must be compatible with direct Anthropic requests.
Do not install a provider extension that replaces Anthropic's model list.

No credential, login, activation, inference, or subscription entitlement is
included. With no configured Anthropic credential the registered model remains
unavailable. Add your own credential later using Pi's normal Anthropic setup.
Billing and access depend on the credential actually configured; an API key can
incur metered charges. A Claude subscription does not imply API entitlement.
Official pricing lists cache reads at $0.20 and 5-minute cache writes at $5 per
million tokens. The configuration uses those standard rates. One-hour cache
writes cost $8 and require separate accounting if enabled. Source:
https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-22).
No cache-warming metadata is enabled.

The old `steak-pi/claude-opus-5-5` launch profile is retired in UltraTerm 2.3.5.
Use the Claude Code harness for Opus instead. Keeping this file does not activate
an Anthropic API route, alter credentials or grant paid-route approval.
Routine workers retain MiMo V2.6 Pro and the ZAI subscription fallback; expert
review waves use the separate CLI route described in [PROFILES.md](./PROFILES.md).

## Compatibility proof and limits

Pi 0.87's Anthropic adapter uses **model metadata**, not the new ID alone, to
select adaptive thinking. `compat.forceAdaptiveThinking: true` produces
`thinking.type: adaptive` and `output_config.effort: high`; otherwise it sends
legacy fixed `budget_tokens`. `thinkingLevelMap.off: null` prevents offering off
and prevents the adapter emitting `thinking.type: disabled`. Only verified
ordinary effort levels are exposed; unverified extended levels are hidden.
Do not infer support for per-turn effort messages or thinking block-binding
controls from model naming; `supportsMidConvoEffort` is deliberately omitted.

Focused tests load the merge fragment through the real model runtime using
in-memory auth/catalog stores, then intercept the real Anthropic adapter payload
before transport. They verify unchanged non-target catalog entries, preserved auth methods,
no configured credential, adaptive/high payload and no fixed budget. A negative
control without the compatibility flag demonstrates why the metadata is required.
No SDK files are modified and no live server acceptance, billing, credential
validity, image inference, or output quality has been tested.
