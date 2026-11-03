import { ambassadorRepository } from '../../infrastructure/repositories/ambassador-repository.ts';
import type {
  AmbassadorProfile,
  FieldMission,
  AmbassadorCommission,
  RegisterRepresentativeInput,
  SubmitMissionInput,
  MissionSearchFilters,
} from '../../domain/Ambassador.ts';

export class AmbassadorService {
  async registerRepresentative(
    userId: string,
    input: RegisterRepresentativeInput,
  ): Promise<AmbassadorProfile> {
    const doc = await ambassadorRepository.registerRepresentative(userId, input);
    return this._mapAmbassador(doc);
  }

  async getAmbassadorProfile(userId: string): Promise<AmbassadorProfile | null> {
    const doc = await ambassadorRepository.getProfileByUser(userId);
    return doc ? this._mapAmbassador(doc) : null;
  }

  async getAvailableMissions(
    filters: MissionSearchFilters = {},
  ): Promise<FieldMission[]> {
    const docs = await ambassadorRepository.listAvailableMissions(filters);
    return docs.map((d: any) => this._mapMission(d));
  }

  async getMissionDetail(missionName: string, userId: string): Promise<FieldMission> {
    const doc = await ambassadorRepository.getMission(missionName, userId);
    if (!doc) throw new Error('MISSION_NOT_FOUND');
    return this._mapMission(doc);
  }

  async reserveMission(
    missionName: string,
    userId: string,
  ): Promise<FieldMission> {
    const doc = await ambassadorRepository.reserveMission(missionName, userId);
    return this._mapMission(doc);
  }

  async submitMission(
    missionName: string,
    userId: string,
    input: SubmitMissionInput,
  ): Promise<FieldMission> {
    const doc = await ambassadorRepository.submitMission(missionName, userId, input);
    return this._mapMission(doc);
  }

  async getMyMissions(userId: string): Promise<FieldMission[]> {
    const docs = await ambassadorRepository.listMyMissions(userId);
    return docs.map((d: any) => this._mapMission(d));
  }

  async getCommissions(appUserId: string): Promise<AmbassadorCommission[]> {
    const docs = await ambassadorRepository.listCommissions(appUserId, undefined, 'RepresentativeMission');
    return docs.map((d: any) => this._mapCommission(d));
  }

  private _mapAmbassador(doc: any): AmbassadorProfile {
    return {
      name: doc.name,
      ambassadeur_name: doc.ambassadeur_name || '',
      email: doc.email || '',
      phone: doc.phone || '',
      zone: doc.zone || [doc.country, doc.city, doc.area].filter(Boolean).join(' - '),
      ambassador_type: doc.ambassador_type || 'Representative',
      country: doc.country || '',
      city: doc.city || '',
      area: doc.area || '',
      status: doc.status || 'Actif',
      max_active_missions: Number(doc.max_active_missions ?? 3),
      commission_rate: Number(doc.commission_rate ?? 0),
      keycloak_id: '',
      app_user_id: doc.app_user_id || '',
      linked_user: '',
      business_unit: 'Konektag',
    };
  }

  private _mapMission(doc: any): FieldMission {
    return {
      name: doc.name,
      mission_name: doc.mission_name || '',
      merchant_profile_id: doc.merchant_profile_id || '',
      merchant_business_name: doc.merchant_business_name || '',
      mission_type: doc.mission_type || 'Verification',
      activity_type: doc.activity_type || 'Commerce',
      country: doc.country || '',
      city: doc.city || '',
      address: doc.address || '',
      priority: doc.priority || 'Medium',
      deadline_hours: Number(doc.deadline_hours ?? 48),
      status: doc.status || 'Available',
      representative: doc.representative || '',
      reserved_at: doc.reserved_at || null,
      reservation_expires_at: doc.reservation_expires_at || null,
      submitted_at: doc.submitted_at || null,
      approved_at: doc.approved_at || null,
      rejected_at: doc.rejected_at || null,
      reward_amount: Number(doc.reward_amount ?? 0),
      currency: doc.currency,
      commission_rule: doc.commission_rule || '',
      evidence: (doc.evidence || []).map((e: any) => ({
        name: e.name || '',
        evidence_type: e.evidence_type || 'Photo',
        file_url: e.file_url || '',
        comment: e.comment || '',
      })),
      business_unit: 'Konektag',
    };
  }

  private _mapCommission(doc: any): AmbassadorCommission {
    return {
      name: doc.name,
      commission_type: doc.commission_type || 'RepresentativeMission',
      status: doc.status || 'Draft',
      ambassadeur: doc.ambassadeur || '',
      mission: doc.mission || null,
      withdrawal: doc.withdrawal || null,
      gross_amount: Number(doc.gross_amount ?? 0),
      commission_rate: Number(doc.commission_rate ?? 0),
      commission_amount: Number(doc.commission_amount ?? 0),
      currency: doc.currency,
      wallet_transaction_ref: doc.wallet_transaction_ref || '',
      payment_date: doc.payment_date || null,
      period_start: doc.period_start || '',
      period_end: doc.period_end || '',
      blnk_entry_id: doc.blnk_entry_id || '',
      business_unit: 'Konektag',
    };
  }
}

export const ambassadorService = new AmbassadorService();
