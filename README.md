<div align="center">

# 🍒 Cherry Pi

**The lucky-core flavor of [Pi](https://pi.dev).**

Minimal by design. Smart where it counts. Jackpot when it lands.

*by Employee Cybernetics*

</div>

---

Cherry Pi is a curated layer for the [Pi coding agent](https://pi.dev) — not a
fork. Stock Pi stays stock; Cherry Pi adds only what earns its place, and
nothing else:

- 🎯 **Todo** — a phased task list with OMP-compatible semantics
  (start / done / block / auto-promotion), persisted locally
- 🤖 **Sub-agents** — bounded parallel agents with mid-run steering, matching
  OMP's orchestration model
- 🧠 **Memory** — AGENTS.md conventions plus opt-in cross-session recall
- 🛠️ **Error correction** — LSP diagnostics and a verify-after-edit loop

Everything is toggleable. Idle overhead: zero.

## Install

```sh
pi install npm:cherry-pi
```

Or try it without installing:

```sh
pi -e npm:cherry-pi
```

## Why Cherry Pi

Stock Pi is the fastest, leanest coding agent we measured. OMP adds
orchestration and opinions — at five times the token cost. Cherry Pi keeps
Pi's speed and leanness and adds the few capabilities that are worth their
weight, each one independently toggleable and benchmarked.

Benchmarks, methodology, and definition hashes: see
[`BENCHMARKS.md`](./BENCHMARKS.md) (published with v0.1).

## Themes

The **cherry** theme ships in the box: cherry red on neutral dark surfaces,
stem-green success, built for legibility under UltraTerm's theme matrix.

## Status

v0.1 in development. Public release lands with benchmark evidence.

## License

[MIT](./LICENSE) · by Employee Cybernetics
