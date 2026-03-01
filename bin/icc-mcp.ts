#!/usr/bin/env node

import { startMCPServer } from '../src/mcp.ts';

startMCPServer().catch((err: Error) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
