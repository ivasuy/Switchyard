#!/usr/bin/env node
import { runCli } from "./run-cli.js";

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
