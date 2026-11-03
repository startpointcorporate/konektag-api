import { erpnextContactService } from './erpnext-contact-service.ts';

/** Projects operational facts only; PostgreSQL remains the financial system of record. */
export const erpnextRegulatoryProjectionService = {
  async projectAcquisition(userId: string, values: { operationId: string; transactionId: string; status: string; rail: string }) {
    await erpnextContactService.project(userId, {
      last_financial_operation_id: values.operationId,
      last_financial_transaction_id: values.transactionId,
      last_financial_operation_status: values.status,
      last_financial_operation_rail: values.rail,
    });
  },

  async projectAccess(userId: string, values: { status: string; reason: string; actionId: string }) {
    await erpnextContactService.project(userId, {
      account_access_status: values.status,
      account_access_reason: values.reason,
      account_access_action_id: values.actionId,
    });
  },
};
