# Harness overhead benchmark

Measures what the harness itself costs, with the model taken out of the
picture: startup, peak memory, per-request prompt size, and USAP fan-out
orchestration. A scripted OpenAI-compatible endpoint (`mock-model.py`) plays a
fixed plan per fixture, so every arm makes the same tool calls and the same
number of model requests. Nothing leaves the machine.

```sh
python3 benchmarks/overhead/run.py --n 5 \
  stock=stock v060=/path/to/steak-pi-0.6.0 v070=. v070run=.+run
```

`stock` runs Pi with no extensions. A path loads that Steak Pi package root
(all extensions, UltraCompress, skill-catalog-lite, skills). `+run` applies
the `steak-pi run` Node defaults. `PI_BIN` selects the host Pi (default:
`./node_modules/.bin/pi`); `MOCK_PORT` the local port.

Cases: `direct` (one file), `modules` (four files), `gate` (eight files,
inline), `fanout` (eight files through one `ultraterm_subagents` dispatch,
eight workers). A run passes when Pi exits 0 and every expected file exists.

Idle multi-session memory uses PSS, following jcode's
`scripts/bench_memory_cli.py`: N interactive TUI sessions in pseudo-terminals,
summed `Pss` from `/proc/<pid>/smaps_rollup` over each process tree.

## Results — September 24, 2026

Pi 0.86.0, Node 22.22, Linux x86-64, 4 vCPU. Medians of 5 runs per cell; the
host Pi and the package's own Pi peer were separate installs, as with
`pi install git:...`.

| Case | Stock Pi | Steak Pi 0.6.0 | 0.7.0 | 0.7.0 via `steak-pi run` |
| --- | ---: | ---: | ---: | ---: |
| direct: wall / peak RSS | 0.64 s / 117 MB | 0.99 s / 148 MB | 0.77 s / 118 MB | 0.72 s / 100 MB |
| modules | 0.65 s / 116 MB | 1.00 s / 148 MB | 0.78 s / 118 MB | 0.68 s / 100 MB |
| gate | 0.66 s / 116 MB | 0.98 s / 137 MB | 0.83 s / 118 MB | 0.70 s / 100 MB |
| fanout (8 workers) | n/a | 3.24 s / 223 MB | 1.22 s / 153 MB | 1.13 s / 125 MB |
| first request bytes | 6,132 | 17,453 | 12,560 | 12,564 |
| tools on first request | 4 | 9 | 6 | 6 |
| pass | 20/20 | 20/20 | 20/20 | 20/20 |

Idle TUI PSS:

| Sessions | Stock Pi | Steak Pi 0.6.0 | 0.7.0 |
| ---: | ---: | ---: | ---: |
| 1 | 116 MB | 150 MB | 113 MB |
| 10 | 639 MB | 963 MB | 610 MB |

For one idle session the `run` defaults change little (113 MB either way);
their effect shows under load (fan-out peak 153 -> 125 MB).

Reference point: jcode v0.88 (Rust, one daemon hosting all sessions) measured
115 MB for one session and 155 MB for ten under the same PSS method. Past one
session that gap is architectural: every Pi session is its own Node process.

Limits: a scripted model measures harness overhead only, not model quality or
provider latency. Timings include process start and exit.
