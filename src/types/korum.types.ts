// Contratos de dominio de KORUM. Los valores de los enums son códigos internos estables;
// las etiquetas visibles (es/ca/en) viven en los catálogos de traducción (ver docs/GLOSARIO.md).

export type Locale = 'es' | 'ca' | 'en';
export const SUPPORTED_LOCALES: readonly Locale[] = ['es', 'ca', 'en'];
export const DEFAULT_LOCALE: Locale = 'es';

export type OrganizationVertical = 'SCHOOL' | 'SPORTS_CLUB' | 'CULTURAL';
export type LegalForm =
  | 'PARENTS_ASSOCIATION'
  | 'SCHOOL_OWNER'
  | 'FOUNDATION'
  | 'SPORTS_ENTITY'
  | 'CULTURAL_ASSOCIATION'
  | 'OTHER_NONPROFIT';
export type CenterOwnership = 'PUBLIC' | 'CONCERTED' | 'PRIVATE' | 'NOT_APPLICABLE';
export type KybStatus = 'PENDING' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';

/** Rol dentro de una organización (OrganizationMember.role). */
export type MemberRole = 'FAMILY' | 'MERCHANT' | 'DIRECTOR' | 'COSIGNER' | 'GATEKEEPER';
/** Rol efectivo de la sesión: un rol de organización o el Super-Admin de la plataforma. */
export type UserRole = MemberRole | 'SUPERADMIN';

export type InitiativeFormat = 'BUDGET' | 'TICKETING';
export type InitiativeStatus =
  | 'BUDGETING'
  | 'FUNDRAISING'
  | 'GOAL_REACHED'
  | 'CLOSED'
  | 'EXPIRED'
  | 'RESIZE_VOTING'
  | 'REFUNDING'
  | 'REFUNDED'
  | 'CANCELLED';

/** Modo de funcionamiento de Mi Hucha (ajuste "hucha.mode" de la consola del Super-Admin). */
export type HuchaMode = 'DISABLED' | 'PLEDGE' | 'REGULATED_WALLET';

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

/** Plantilla por defecto del vertical CULTURAL (la entidad puede editar sus grupos). */
export const OFFICIAL_CULTURAL_GROUPS: ParticipationGroupCluster[] = [
  {
    group: '🎵 Comunidad de la Entidad',
    items: [
      'Alumnado / Integrantes',
      'Familias',
      'Profesorado / Monitores',
      'Socios / Amigos',
      'Antiguos Miembros'
    ]
  }
];

export type BracketMode = 'FLAT' | 'MARGINAL';

export interface KorumGlobalRulesCents {
  exemptLimitCents: number;
  bracketMode: BracketMode;
  t1MaxCents: number;
  t2MaxCents: number;
  t1Bps: number;
  t2Bps: number;
  t3Bps: number;
  sponsorFeeBps: number;
  fullIntegrityCheckCents: number;
  guaranteePresetsCents: number[];
  defaultGuaranteeIdx: number;
  gatewayPctBps: number;
  gatewayFixedCents: number;
  topupFeeCents: number;
  topupFeeBps: number;
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

export interface KorumSigner {
  role: Extract<MemberRole, 'DIRECTOR' | 'COSIGNER'>;
  /** Cargo visible: "Presidencia del AFA", "Tesorería del club", "Representación del patronato"... */
  roleLabel: string;
  name: string;
  email: string;
}

export interface KorumOrganization {
  id: string;
  slug: string;
  /** Nombre público de la comunidad. */
  name: string;
  /** Razón social de la entidad titular de los fondos. */
  legalName: string;
  legalForm: LegalForm;
  centerOwnership: CenterOwnership;
  vertical: OrganizationVertical;
  province: string;
  provinceCode: string;
  contentLocale: Locale;
  signers: KorumSigner[];
  contactPhone: string;
  cif: string;
  iban: string;
  walletId: string;
  kybStatus: KybStatus;
  health: 'OK' | 'CALL';
  completedThisYear: number;
  completedHistorical: number;
  activeSponsorsCount: number;
  historicalSponsorsCount: number;
  /** 0 = sin medalla, 1 Bronce, 2 Plata, 3 Oro. */
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
  medalRankApplied: number;
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
  senderRole: 'FAMILY' | 'ORGANIZATION' | 'SYSTEM';
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
  target: 'ORGANIZATION' | 'SUPERADMIN';
  subject: string;
  message: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  /** La escribe la propia entidad desde su panel (buzón hacia KORUM, Sprint 4.4c). */
  fromOrganization?: boolean;
  createdAt: string;
}

