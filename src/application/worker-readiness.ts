import { computeOperationalReadiness } from './services/operational-health-service';
import pool from '../infrastructure/database/pool';
const processId=process.argv[2];
if(!['outbox-dispatcher','accounting-worker'].includes(processId))process.exit(2);
try {
  const status=await computeOperationalReadiness();
  const processHealth=status.processes.find(p=>p.processId===processId);
  if(!processHealth?.healthy) { console.error(processHealth?.reasonCode || 'PROCESS_NO_EVIDENCE');process.exitCode=1; }
} finally { await pool.end(); }
