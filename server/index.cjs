#!/usr/bin/env node
"use strict";
const { startHost } = require("./host.cjs");

startHost().catch((error) => {
  console.error("Unable to initialize Host core", error);
  process.exitCode = 1;
});
