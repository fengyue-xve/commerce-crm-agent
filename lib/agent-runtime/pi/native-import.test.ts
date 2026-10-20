// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isTsxWorker } from "./native-import";

describe("tsx ESM boundary detection", () => {
  const detect = (argv: string[], execArgv: string[]) => {
    const before = { argv: process.argv, execArgv: process.execArgv };
    try {
      process.argv = argv;
      process.execArgv = execArgv;
      return isTsxWorker();
    } finally {
      process.argv = before.argv;
      process.execArgv = before.execArgv;
    }
  };
  it("detects a Windows loader when tsx has rewritten argv to the entrypoint", () => {
    expect(
      detect(
        ["node.exe", "scripts/demo.mts"],
        ["--require", "C:\\demo\\node_modules\\tsx\\dist\\preflight.cjs"],
      ),
    ).toBe(true);
  });
  it("detects the POSIX CLI and file URL loader", () => {
    expect(detect(["node", "/repo/node_modules/tsx/dist/cli.mjs"], [])).toBe(true);
    expect(
      detect(["node", "worker.ts"], ["--import", "file:///repo/node_modules/tsx/dist/loader.mjs"]),
    ).toBe(true);
  });
  it("keeps Vitest and ordinary node on their bundler/native import path", () => {
    expect(detect(["node", "/repo/node_modules/vitest/vitest.mjs"], ["--conditions", "node"])).toBe(
      false,
    );
  });
});
