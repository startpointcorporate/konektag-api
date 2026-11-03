/**
 * Standalone Accounting Worker Entry Point
 *
 * Runs as a separate process, independent of the HTTP server.
 * Started via: node --import ./dist/accounting-worker-entry.mjs
 * Or: docker run --network common-network ...
 *
 * Exits after processing all pending events and continues via setInterval.
 */

import { startAccountingWorker } from './accounting-worker.ts';
import '../infrastructure/database/pool.ts';

console.log('[AccountingWorker] Standalone entry point starting...');
startAccountingWorker();

// Keep the process alive
process.on('SIGTERM', () => {
  console.log('[AccountingWorker] Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[AccountingWorker] Received SIGINT, shutting down...');
  process.exit(0);
});
