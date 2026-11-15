import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const pkg = JSON.parse(read("package.json"));
const documents = ["README.md", "docs/INSTALL.md", "docs/REFERENCE.md"];

describe("getting-started documentation", () => {
  it("pins install examples to the package version", () => {
    const readme = read("README.md");
    expect(readme).toContain(`steak-pi@v${pkg.version}`);
    const archives = read("docs/INSTALL.md").match(/steak-pi-\d+\.\d+\.\d+\.tgz/g);
    expect(archives?.length).toBeGreaterThan(0);
    expect(archives?.every((name) => name === `steak-pi-${pkg.version}.tgz`)).toBe(true);
  });

  it("keeps relative documentation links resolvable", () => {
    for (const document of documents) {
      for (const [, link] of read(document).matchAll(/\]\(([^)]+)\)/g)) {
        if (link.includes("://") || link.startsWith("#")) continue;
        const target = resolve(root, dirname(document), link.split("#")[0]);
        expect(existsSync(target), `${document}: ${link}`).toBe(true);
      }
    }
  });

  it("includes extracted reference pages in package archives", () => {
    for (const document of documents.slice(1)) expect(pkg.files).toContain(document);
  });
});
