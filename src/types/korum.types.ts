export type OrganizationVertical = 'SCHOOL' | 'SPORTS_CLUB' | 'CULTURAL';
export type UserRole =
  | 'FAMILY'
  | 'MERCHANT'
  | 'DIRECTOR'
  | 'AFA_PRESIDENT'
  | 'GATEKEEPER'
  | 'SUPERADMIN';

export type InitiativeFormat = 'BUDGET' | 'TICKETING';
export type InitiativeStatus =
  | 'Presupuestación'
  | 'Recaudando'
  | 'Logro Conseguido'
  | 'Cerrada'
  | 'Expirada'
  | 'Reembolsada';

export type CategoryRuleType = 'EXEMPT' | 'BRACKETS';
export type SponsorCategoryLevel = 'ORO' | 'PLATA' | 'BRONCE';
export type SponsorStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'CREDIT_POOL' | 'REFUNDED';
export type SponsorRenewalRule = 'SOONEST' | 'PROPORTIONAL' | 'MANUAL';
export type SignatureStatus = 'VERIFIED' | 'SUSPICIOUS';
export type IdeaPhase =
  | 'PHASE0_MOD'
  | 'PUBLIC_VOTING'
  | 'DOUBLE_CHECK'
  | 'CONVERTED'
  | 'REJECTED';

export interface ParticipationGroupCluster {
  group: string;
  items: string[];
}

export const OFFICIAL_SCHOOL_13_COURSES: ParticipationGroupCluster[] = [
  {
    group: '🎈 Educación Infantil (3 Cursos)',
    items: ['Infantil 3 años (I3)', 'Infantil 4 años (I4)', 'Infantil 5 años (I5)']
  },
  {
    group: '📘 Educación Primaria (6 Cursos)',
    items: [
      '1º de Primaria',
      '2º de Primaria',
      '3º de Primaria',
      '4º de Primaria',
      '5º de Primaria',
      '6º de Primaria'
    ]
  },
  {
    group: '🎓 Educación Secundaria - ESO (4 Cursos)',
    items: ['1º de ESO', '2º de ESO', '3º de ESO', '4º de ESO']
  },
  {
    group: '💛 Comunidad Ampliada',
    items: ['Vecino / Amigo del Barrio', 'Antiguo Alumno / Familiar']
  }
];

export const OFFICIAL_SPORTS_CLUB_GROUPS: ParticipationGroupCluster[] = [
  {
    group: '🏀 Categorías Base (5 Equipos)',
    items: ['Prebenjamín', 'Benjamín', 'Alevín', 'Infantil', 'Cadete']
  },
  {
    group: '🏆 Categorías Superiores (3 Equipos)',
    items: ['Juvenil / Júnior', 'Sénior / Primer Equipo', 'Escuela / Veteranos']
  },
  {
    group: '💛 Comunidad del Club',
    items: ['Socio / Afición', 'Antiguo Jugador / Familiar']
  }
];

export interface KorumGlobalRulesCents {
  exemptLimitCents: number;
  t1Bps: number;
  t2Bps: number;
  t3Bps: number;
  sponsorFeeBps: number;
  fullIntegrityCheckCents: number;
  tipPresetsCents: number[];
  defaultTipIdx: number;
  gatewayPctBps: number;
  gatewayFixedCents: number;
  topupFeeCents: number;
  ticketFeeFixedCents: number;
  ticketFeeBps: number;
  maintActive: boolean;
  maintPerInitCents: number;
  maintAnnualCapCents: number;
}

export interface KorumMedalTier {
  key: 'bronze' | 'silver' | 'gold';
  name: string;
  icon: string;
  rank: number;
  campaignsRequired: number;
  grantCents: number;
}

export interface KorumCategory {
  name: string;
  rule: CategoryRuleType;
  icon: string;
  isCustom?: boolean;
}

export interface CourseProgress {
  groupName: string;
  familiesCount: number;
}

export interface KorumOrganization {
  id: string;
  slug: string;
  name: string;
  vertical: OrganizationVertical;
  orgType: string;
  province: string;
  director: string;
  afaPresident: string;
  phone: string;
  cif: string;
  iban: string;
  walletId: string;
  kybValidated: boolean;
  health: 'OK' | 'CALL';
  completedThisYear: number;
  completedHistorical: number;
  activeSponsorsCount: number;
  historicalSponsorsCount: number;
  medal: string;
  medalRank: number;
  ley49: boolean;
  customRules: boolean;
  exemptLimitCents: number;
  exemptRemainingCents: number;
  medalGrantAvailableCents: number;
  medalGrantUsedInTitle?: string | null;
  t1Bps: number;
  t2Bps: number;
  t3Bps: number;
  sponsorFeeBps: number;
  fullIntegrityCheckCents: number;
  ticketFeeFixedCents: number;
  ticketFeeBps: number;
  maintActive: boolean;
  maintPerInitCents: number;
  maintAnnualCapCents: number;
  maintPaidCents: number;
  donationPresetsCents: number[];
  defaultDonationIdx: number;
  sponsorTiersCents: number[];
  sponsorRenewalRule: SponsorRenewalRule;
  participationGroups?: ParticipationGroupCluster[];
  minVotes: number;
  maxIdeaDays: number;
  brandPrimary: string;
  brandSecondary: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  customCategories: KorumCategory[];
  categoryRuleOverrides: Record<string, CategoryRuleType>;
}

export interface KorumInitiative {
  id: number;
  format: InitiativeFormat;
  walletEscrowId: string;
  organizationId: string;
  schoolName: string;
  province: string;
  academicYear: string;
  title: string;
  category: string;
  stage: string;
  status: InitiativeStatus;
  stepIndex: number;
  closesAt: string;
  quarter: string;
  raisedCents: number;
  goalCents: number;
  totalContributions: number;
  costMatCents: number;
  costInstCents: number;
  contingencyBps: number;
  showPublicBreakdown: boolean;
  defaultExemptAppliedCents: number;
  medalExemptAppliedCents: number;
  medalNameApplied: string;
  bracketRateAppliedBps: number;
  bracketFeeCents: number;
  maintFeeCents: number;
  gatewayFeeCents: number;
  absorbsGatewayCostByKorum?: boolean;
  matchingPoolTotalCents?: number;
  matchingPoolRemainingCents?: number;
  matchingSponsorName?: string | null;
  ticketSubtype?: 'EVENT' | 'RAFFLE';
  ticketPriceCents?: number;
  ticketMax?: number;
  ticketsSold?: number;
  ticketFeeMode?: 'ADD' | 'INC';
  ticketVenue?: string;
  plaqueEnabled: boolean;
  rewardEnabled: boolean;
  targetFamiliesPerCourse: number;
  rewardText: string;
  description: string;
  thanksMessage?: string;
  coverImage?: string | null;
  beforeImage?: string | null;
  afterImage?: string | null;
  courses: CourseProgress[];
}

export interface KorumSponsor {
  id: number;
  organizationId: string;
  initiativeId: number | null;
  name: string;
  cif: string;
  contactPerson: string;
  phone: string;
  email: string;
  sector: string;
  categoryLevel: SponsorCategoryLevel;
  tierRank: number;
  tierLabel: string;
  amountCents: number;
  feeGeneratedCents: number;
  isMatchingPool?: boolean;
  initiativeTitle: string;
  promo: string;
  code: string;
  autoRenew: boolean;
  status: SponsorStatus;
  expiresAt: string;
}

export interface KorumIdeaAuditEntry {
  email: string;
  canonicalEmail: string;
  deviceFingerprint: string;
  accountOrder: number;
  status: SignatureStatus;
  reason: string;
}

export interface KorumIdeaMessage {
  senderRole: 'FAMILY' | 'SCHOOL' | 'SYSTEM';
  senderLabel: string;
  body: string;
  createdAt?: string;
}

export interface KorumIdea {
  id: number;
  organizationId: string;
  alias: string;
  authorCanonicalEmail: string;
  title: string;
  category: string;
  description: string;
  phase: IdeaPhase;
  votes: number;
  verifiedVotes: number;
  suspiciousVotes: number;
  expiresAt: string;
  auditLog: KorumIdeaAuditEntry[];
  messages: KorumIdeaMessage[];
}

export interface KorumInvoice {
  invoiceNumber: string;
  organizationId: string;
  recipientName: string;
  recipientTaxId: string;
  concept: string;
  baseAmountCents: number;
  taxRateBps: number;
  taxAmountCents: number;
  totalAmountCents: number;
  verifactuHash: string;
  verifactuQrUrl: string;
  issuedAt: string;
}

export interface KorumSupportTicket {
  ticketCode: string;
  organizationId?: string | null;
  originLabel: string;
  targetRole: 'SCHOOL' | 'SUPERADMIN';
  subject: string;
  message: string;
  status: 'OPEN' | 'RESOLVED';
  createdAt: string;
}

