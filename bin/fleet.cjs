#!/usr/bin/env node
"use strict";

module.exports = require("./aios.cjs");
if (require.main === module) {
  require("node:child_process").spawnSync(
    process.execPath,
    [require.resolve("./aios.cjs"), ...process.argv.slice(2)],
    { stdio: "inherit" }
  );
}
