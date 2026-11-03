import { startOutboxDispatcher } from './outbox-dispatcher';
startOutboxDispatcher().catch(error=>{console.error('[Outbox]',error);process.exit(1);});
process.on('SIGTERM',()=>process.exit(0));
process.on('SIGINT',()=>process.exit(0));
