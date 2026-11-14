import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
const tag = process.env.RELEASE_TAG;
assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/u, "Use a stable vX.Y.Z version tag");
assert.equal(tag, `v${pkg.version}`, "Tag must match package.json version");
assert.equal(pkg.name, "@zha30/n8n-nodes-openlist");
assert.equal(pkg.publishConfig.access, "public");
assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org/");
assert.equal(
  pkg.repository.url,
  `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`,
  "Repository metadata must match the publishing GitHub repository",
);
console.log(`Release identity checked: ${pkg.name}@${pkg.version}`);
