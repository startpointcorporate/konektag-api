import { pawaPayDepositService } from '../../../application/services/pay/pawapay-deposit-service.ts';
if (process.env.PAWAPAY_API_URL && process.env.PAWAPAY_API_TOKEN) pawaPayDepositService.reconcile().then(count => console.log(`[pawapay] reconciled ${count}`)).catch(error => { console.error(error); process.exitCode = 1; });
