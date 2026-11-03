export type AmbassadorType = 'Representative' | 'Agent' | 'Both';
export type AmbassadorStatus = 'Actif' | 'Inactif';
export type MissionStatus = 'Available' | 'Reserved' | 'InProgress' | 'Submitted' | 'Approved' | 'Rejected' | 'Expired' | 'Paid';
export type MissionType = 'Verification' | 'Completion' | 'Media' | 'Validation';
export type EvidenceType = 'Photo' | 'Video' | 'Document' | 'CustomerReview' | 'Comment';
export type CommissionStatus = 'Draft' | 'Calcule' | 'Valide' | 'Paye' | 'Rejete';
export type CommissionType = 'RepresentativeMission' | 'AgentWithdrawal';
export type ApplicationStatus = 'Draft' | 'Submitted' | 'UnderReview' | 'Approved' | 'Rejected' | 'Suspended';
export type EquipmentStatus = 'Planned' | 'Assigned' | 'Delivered' | 'Lost' | 'Returned' | 'Disabled';
export type EquipmentType = 'MarketingKit' | 'Poster' | 'Sticker' | 'QRCode' | 'Tablet' | 'TrainingMaterial' | 'Other';
export type MissionPriority = 'Low' | 'Medium' | 'High' | 'Urgent';
export type ActivityType = 'Restaurant' | 'Hotel' | 'Commerce';

export interface AmbassadorProfile {
  name: string;
  ambassadeur_name: string;
  email: string;
  phone: string;
  zone: string;
  ambassador_type: AmbassadorType;
  country: string;
  city: string;
  area: string;
  status: AmbassadorStatus;
  max_active_missions: number;
  commission_rate: number;
  keycloak_id: string;
  app_user_id: string;
  linked_user: string;
  business_unit: string;
}

export interface FieldMission {
  name: string;
  mission_name: string;
  merchant_profile_id?: string;
  merchant_business_name: string;
  mission_type: MissionType;
  activity_type: ActivityType;
  country: string;
  city: string;
  address: string;
  priority: MissionPriority;
  deadline_hours: number;
  status: MissionStatus;
  representative: string;
  reserved_at: string | null;
  reservation_expires_at: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  reward_amount: number;
  currency: string;
  commission_rule: string;
  evidence: MissionEvidence[];
  business_unit: string;
}

export interface MissionEvidence {
  name: string;
  evidence_type: EvidenceType;
  file_url: string;
  comment: string;
}

export interface AmbassadorCommission {
  name: string;
  commission_type: CommissionType;
  status: CommissionStatus;
  ambassadeur: string;
  mission: string | null;
  withdrawal: string | null;
  gross_amount: number;
  commission_rate: number;
  commission_amount: number;
  currency: string;
  wallet_transaction_ref: string;
  payment_date: string | null;
  period_start: string;
  period_end: string;
  blnk_entry_id: string;
  business_unit: string;
}

export interface AgentApplication {
  name: string;
  merchant_profile_id: string;
  business_name: string;
  manager_name: string;
  phone: string;
  email: string;
  country: string;
  city: string;
  full_address: string;
  activity_type: ActivityType;
  estimated_client_volume: number;
  available_space: string;
  opening_hours: string;
  justificatif_file: string;
  comment: string;
  terms_accepted: boolean;
  status: ApplicationStatus;
  ambassadeur: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string;
  rejection_reason: string;
  business_unit: string;
}

export interface AgentEquipment {
  name: string;
  agent: string;
  equipment_type: EquipmentType;
  serial_number: string;
  assigned_date: string | null;
  status: EquipmentStatus;
  notes: string;
}

export interface CommissionRule {
  name: string;
  rule_name: string;
  country: string;
  mission_type: MissionType;
  reward_amount: number;
  currency: string;
  is_active: boolean;
}

export interface RegisterRepresentativeInput {
  country: string;
  city: string;
  area?: string;
}

export interface ReserveMissionInput {
  mission_name: string;
  representative: string;
}

export interface SubmitMissionInput {
  evidence: {
    evidence_type: EvidenceType;
    file_url?: string;
    comment?: string;
  }[];
}

export interface ApplyForAgentInput {
  merchant_profile_id?: string;
  business_name: string;
  manager_name: string;
  phone: string;
  email: string;
  country: string;
  city: string;
  full_address: string;
  activity_type: ActivityType;
  estimated_client_volume?: number;
  available_space?: string;
  opening_hours?: string;
  justificatif_file?: string;
  comment?: string;
  terms_accepted: boolean;
}

export interface MissionSearchFilters {
  country?: string;
  city?: string;
  mission_type?: MissionType;
  activity_type?: ActivityType;
  priority?: MissionPriority;
  status?: MissionStatus;
  limit?: number;
  offset?: number;
}

export interface AgentSearchFilters {
  country?: string;
  city?: string;
  area?: string;
  ambassador_type?: AmbassadorType;
  limit?: number;
  offset?: number;
}

export interface AgentDashboardStats {
  total_withdrawals: number;
  total_volume: number;
  commissions_earned: number;
  commissions_pending: number;
  commissions_paid: number;
}
