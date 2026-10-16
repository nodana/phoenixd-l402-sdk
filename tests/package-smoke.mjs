import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { L402, L402Error } from "@nodana/phoenixd-l402-sdk";

const require = createRequire(import.meta.url);

const cjs = require("@nodana/phoenixd-l402-sdk");
assert.equal(typeof L402.create, "function");
assert.equal(typeof cjs.L402.create, "function");
assert.equal("memoryStore" in cjs, false);
assert.equal("redisStore" in cjs, false);
assert.equal(
  new L402Error("invalid_invoice", "failure").code,
  "invalid_invoice",
);

for (const suffix of ["/server", "/client"]) {
  assert.throws(() => require(`@nodana/phoenixd-l402-sdk${suffix}`), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
}

const result = spawnSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "tests/exports.mts",
    "tests/exports.cts",
  ],
  { stdio: "inherit" },
);

assert.equal(
  result.status,
  0,
  "Published declarations must work for ESM and CommonJS consumers",
);

console.log(
  "Package exports and consumer declarations passed (ESM + CommonJS).",
);
