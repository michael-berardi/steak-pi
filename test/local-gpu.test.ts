// The GPU utilisation probe: parsing the IORegistry answer, and every way it can come back unknown. No GPU is touched:
// the command runner is injected.
import { describe, expect, it } from "vitest";
import { createGpuProbe, IOREG_ARGS, parseDeviceUtilization } from "../src/local/gpu-probe.ts";

// The shape `ioreg -r -d 1 -w 0 -c IOAccelerator` prints (trimmed to the fields that matter).
const IOREG = `+-o AGXAcceleratorG15X  <class AGXAcceleratorG15X, id 0x100000abc, registered, matched, active, busy 0, retain 9>
    {
      "IOClass" = "AGXAcceleratorG15X"
      "PerformanceStatistics" = {"Device Utilization %"=98,"Renderer Utilization %"=98,"Tiler Utilization %"=13,"In use system memory"=0}
    }`;

describe("parseDeviceUtilization", () => {
  it("reads Device Utilization % from an IORegistry dump", () => {
    expect(parseDeviceUtilization(IOREG)).toBe(98);
    expect(parseDeviceUtilization('"Device Utilization %" = 5')).toBe(5);
    expect(parseDeviceUtilization('"Device Utilization %"=100')).toBe(100);
  });

  it("is undefined when the dump does not carry it", () => {
    expect(parseDeviceUtilization("")).toBeUndefined();
    expect(parseDeviceUtilization('"Renderer Utilization %"=98')).toBeUndefined();
    expect(parseDeviceUtilization('"Device Utilization %"=abc')).toBeUndefined();
    expect(parseDeviceUtilization('"Device Utilization %"=140')).toBeUndefined();
  });
});

describe("createGpuProbe", () => {
  const probe = (platform: string, run: (file: string, args: readonly string[], timeoutMs: number) => string | undefined) =>
    createGpuProbe({ platform: () => platform, run, timeoutMs: 2000 });

  it("samples the accelerator on macOS with one unprivileged ioreg read", async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    const sample = await probe("darwin", (file, args, timeoutMs) => { calls.push({ file, args, timeoutMs }); return IOREG; })();
    expect(sample).toEqual({ kind: "util", percent: 98 });
    expect(calls).toEqual([{ file: "ioreg", args: IOREG_ARGS, timeoutMs: 2000 }]);
  });

  it("is unknown, with the reason, on any other platform", async () => {
    expect(await probe("linux", () => { throw new Error("must not run"); })()).toEqual({ kind: "unknown", reason: "no GPU utilisation probe on linux" });
  });

  it("is unknown when the command fails, prints nothing, or prints something unparsable", async () => {
    expect(await probe("darwin", () => { throw new Error("spawn ioreg ENOENT"); })()).toEqual({ kind: "unknown", reason: "ioreg failed: spawn ioreg ENOENT" });
    expect(await probe("darwin", () => undefined)()).toEqual({ kind: "unknown", reason: "ioreg produced no output" });
    expect(await probe("darwin", () => "no statistics here")()).toEqual({ kind: "unknown", reason: "ioreg output has no Device Utilization %" });
  });
});
