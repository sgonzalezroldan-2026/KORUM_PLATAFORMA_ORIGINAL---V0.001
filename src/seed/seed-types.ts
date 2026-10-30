import seedJson from '@/mocks/seed_data.json';
import type {
  KorumCategory,
  KorumGlobalRulesCents,
  KorumIdea,
  KorumInitiative,
  KorumInvoice,
  KorumMedalTier,
  KorumOrganization,
  KorumSponsor,
  KorumSupportTicket
} from '@/types/korum.types';

/** Forma de `src/mocks/seed_data.json`. El escáner de invariantes y los tests de la semilla vigilan su coherencia. */
export interface KorumSeedData {
  globalRules: KorumGlobalRulesCents;
  medalsConfig: KorumMedalTier[];
  globalCategories: Array<KorumCategory & { sortOrder: number }>;
  schools: KorumOrganization[];
  initiatives: KorumInitiative[];
  sponsors: KorumSponsor[];
  ideas: KorumIdea[];
  invoices: KorumInvoice[];
  supportTickets: KorumSupportTicket[];
}

/** Datos de la semilla tal como están en el archivo (sin copiarlos: los planes no los modifican). */
export function loadSeedData(): KorumSeedData {
  return seedJson as unknown as KorumSeedData;
}
