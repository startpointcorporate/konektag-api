import { ambassadorRepository } from '../../infrastructure/repositories/ambassador-repository.ts';
import type {
  AgentApplication,
  AmbassadorProfile,
  AmbassadorCommission,
  ApplyForAgentInput,
  AgentSearchFilters,
  AgentDashboardStats,
} from '../../domain/Ambassador.ts';

export class AgentService {
  async applyForAgent(userId: string, input: ApplyForAgentInput): Promise<AgentApplication> {
    return this._mapApplication(await ambassadorRepository.createAgentApplication(userId, input));
  }

  async getMyApplication(
    userId: string,
    merchantProfileId: string,
  ): Promise<AgentApplication | null> {
    const doc = await ambassadorRepository.getAgentApplication(userId, merchantProfileId);
    return doc ? this._mapApplication(doc) : null;
  }

  async getAgents(filters: AgentSearchFilters = {}): Promise<AmbassadorProfile[]> {
    const docs = await ambassadorRepository.listAgents(filters);
    return docs.map((d: any) => this._mapAmbassador(d));
  }

  async getAgentDetail(ambassadorName: string): Promise<AmbassadorProfile | null> {
    const doc = await ambassadorRepository.getAgent(ambassadorName);
    if (!doc) return null;
    return this._mapAmbassador(doc);
  }

  async getAgentDashboard(
    userId: string,
    ambassadorName: string,
  ): Promise<AgentDashboardStats> {
    if (!await ambassadorRepository.getOwnedAgent(userId, ambassadorName)) throw new Error('FORBIDDEN_AGENT');
    const items = await ambassadorRepository.listCommissions(userId, ambassadorName, 'AgentWithdrawal');
    let commissions_earned = 0;
    let commissions_pending = 0;
    let commissions_paid = 0;
    let total_volume = 0;
    let total_withdrawals = 0;

    for (const c of items) {
      if (c.status === 'Paye') {
        commissions_paid += c.commission_amount || 0;
        total_volume += c.gross_amount || 0;
        total_withdrawals += 1;
      } else if (c.status === 'Rejete') {
        continue;
      } else {
        commissions_pending += c.commission_amount || 0;
      }
      commissions_earned += c.commission_amount || 0;
    }

    return {
      total_withdrawals,
      total_volume,
      commissions_earned,
      commissions_pending,
      commissions_paid,
    };
  }

  async getAgentCommissions(
    userId: string,
    ambassadorName: string,
  ): Promise<AmbassadorCommission[]> {
    if (!await ambassadorRepository.getOwnedAgent(userId, ambassadorName)) throw new Error('FORBIDDEN_AGENT');
    const docs = await ambassadorRepository.listCommissions(userId, ambassadorName, 'AgentWithdrawal');
    return docs.map((d: any) => this._mapCommission(d));
  }

  private _mapApplication(doc: any): AgentApplication {
    return {
      name: String(doc.id || doc.name),
      merchant_profile_id: doc.merchant_profile_id || '',
      business_name: doc.business_name || '',
      manager_name: doc.manager_name || '',
      phone: doc.phone || '',
      email: doc.email || '',
      country: doc.country || '',
      city: doc.city || '',
      full_address: doc.full_address || '',
      activity_type: doc.activity_type || 'Commerce',
      estimated_client_volume: Number(doc.estimated_client_volume ?? 0),
      available_space: doc.available_space || '',
      opening_hours: doc.opening_hours || '',
      justificatif_file: doc.justificatif_file || '',
      comment: doc.message || doc.comment || '',
      terms_accepted: !!doc.terms_accepted,
      status: ({ pending: 'Submitted', contacted: 'UnderReview', approved: 'Approved', rejected: 'Rejected' } as Record<string, string>)[doc.status] || doc.status || 'Draft',
      ambassadeur: doc.ambassadeur || '',
      submitted_at: doc.submitted_at || null,
      reviewed_at: doc.reviewed_at || null,
      reviewed_by: doc.reviewed_by || '',
      rejection_reason: doc.rejection_reason || '',
      business_unit: 'Konektag',
    };
  }

  private _mapAmbassador(doc: any): AmbassadorProfile {
    return {
      name: doc.name,
      ambassadeur_name: doc.ambassadeur_name || '',
      email: doc.email || '',
      phone: doc.phone || '',
      zone: doc.zone || [doc.country, doc.city, doc.area].filter(Boolean).join(' - '),
      ambassador_type: doc.ambassador_type || 'Agent',
      country: doc.country || '',
      city: doc.city || '',
      area: doc.area || '',
      status: doc.status || 'Actif',
      max_active_missions: Number(doc.max_active_missions ?? 0),
      commission_rate: Number(doc.commission_rate ?? 0),
      keycloak_id: '',
      app_user_id: doc.app_user_id || '',
      linked_user: '',
      business_unit: 'Konektag',
    };
  }

  private _mapCommission(doc: any): AmbassadorCommission {
    return {
      name: doc.name,
      commission_type: doc.commission_type || 'AgentWithdrawal',
      status: doc.status || 'Draft',
      ambassadeur: doc.ambassadeur || '',
      mission: doc.mission || null,
      withdrawal: doc.withdrawal || null,
      gross_amount: Number(doc.gross_amount ?? 0),
      commission_rate: Number(doc.commission_rate ?? 0),
      commission_amount: Number(doc.commission_amount ?? 0),
      currency: doc.currency || 'XOF',
      wallet_transaction_ref: doc.wallet_transaction_ref || '',
      payment_date: doc.payment_date || null,
      period_start: doc.period_start || '',
      period_end: doc.period_end || '',
      blnk_entry_id: doc.blnk_entry_id || '',
      business_unit: 'Konektag',
    };
  }
}

export const agentService = new AgentService();
