import { z } from 'zod';
import { PILLAR_PAGES } from '@/lib/seo/marketing-routes';
import { OFFICIAL_CULTURAL_GROUPS, OFFICIAL_SCHOOL_13_COURSES, OFFICIAL_SPORTS_CLUB_GROUPS, type ParticipationGroupCluster } from '@/types/korum.types';
import { provinceByCode } from './provinces';

/**
 * Reglas del alta autónoma de una entidad (`/registro-comunidad`, ARQUITECTURA_LANDING §3, QA-M02). Funciones puras: el formulario las usa
 * para avisar campo a campo y el servidor las vuelve a aplicar antes de crear nada (nunca se confía en lo que valida el navegador).
 *
 * - Un **colegio público** solo puede darse de alta a través de su AMPA/AFA (`PARENTS_ASSOCIATION`).
 * - El **titular de un colegio privado o concertado** (`SCHOOL_OWNER`) solo existe en colegios (en uno público lo impide la regla anterior) y
 *   **no puede marcar la Ley 49/2002**:
 *   lo aportado a un colegio con ánimo de lucro puede no ser donación (skill antifraude §5; lo confirma la asesoría).
 * - Las dos personas firmantes son **dos bandejas distintas**: `laura@gmail.com` y `laura+tesoreria@gmail.com` son la misma persona.
 * - La URL propia (`korum.app/cervantes`) no puede chocar con una ruta de KORUM.
 */

export const VERTICALS = ['SCHOOL', 'SPORTS_CLUB', 'CULTURAL'] as const;
export const LEGAL_FORMS = ['PARENTS_ASSOCIATION', 'SCHOOL_OWNER', 'FOUNDATION', 'SPORTS_ENTITY', 'CULTURAL_ASSOCIATION', 'OTHER_NONPROFIT'] as const;
export const CENTER_OWNERSHIPS = ['PUBLIC', 'CONCERTED', 'PRIVATE', 'NOT_APPLICABLE'] as const;
export const CONTENT_LOCALES = ['es', 'ca', 'en'] as const;

/** Formas jurídicas que tienen sentido en cada vertical (el formulario solo ofrece estas). */
export const LEGAL_FORMS_BY_VERTICAL: Record<(typeof VERTICALS)[number], readonly (typeof LEGAL_FORMS)[number][]> = {
  SCHOOL: ['PARENTS_ASSOCIATION', 'SCHOOL_OWNER', 'FOUNDATION', 'OTHER_NONPROFIT'],
  SPORTS_CLUB: ['SPORTS_ENTITY', 'FOUNDATION', 'OTHER_NONPROFIT'],
  CULTURAL: ['CULTURAL_ASSOCIATION', 'FOUNDATION', 'OTHER_NONPROFIT']
};

/** Primer tramo de la ruta que ya usa KORUM: una entidad no puede llamarse así. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'es', 'ca', 'en', 'api', 'admin', 'panel', 'login', 'registro-comunidad', 'acceso', 'invitacion', 'dev', 'cuenta', 'mi-cuenta', 'mi-hucha',
  'ayuda', 'soporte', 'legal', 'privacidad', 'cookies', 'condiciones', 'guias', 'blog', 'robots.txt', 'sitemap.xml', 'llms.txt', 'icon.svg', 'korum',
  ...PILLAR_PAGES.map((page) => page.path.slice(1))
]);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** Propuesta de URL a partir del nombre: minúsculas, sin acentos ni signos, guiones entre palabras. */
export function suggestSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** Sin enlaces, dominios ni direcciones de email: estos textos salen en el email de invitación, firmado por KORUM (anti-suplantación). */
export const LINK_LIKE = /https?:|www\.|@|\b[a-z0-9-]+\.(?:[a-z]{2,24})\b/i;
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const plainText = (min: number, max: number) => text(min, max).refine((value) => !LINK_LIKE.test(value));
const phone = z.string().trim().regex(/^\+?[0-9 ]{9,16}$/);

const signer = {
  name: text(2, 80),
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  phone,
  roleLabel: plainText(3, 60)
};

export const registrationSchema = z.object({
  vertical: z.enum(VERTICALS),
  name: plainText(3, 80),
  provinceCode: z.string().regex(/^\d{2}$/),
  city: text(2, 60),
  postalCode: z.string().trim().regex(/^\d{5}$/),
  legalName: plainText(3, 120),
  legalForm: z.enum(LEGAL_FORMS),
  centerOwnership: z.enum(CENTER_OWNERSHIPS),
  ley49: z.boolean(),
  contentLocale: z.enum(CONTENT_LOCALES),
  publicIndexing: z.boolean(),
  slug: z.string().trim().toLowerCase(),
  director: z.object({ ...signer, password: z.string().min(12).max(128) }),
  cosigner: z.object(signer),
  representationDeclared: z.literal(true)
});

export type RegistrationInput = z.infer<typeof registrationSchema>;

export type RegistrationIssue =
  | 'PUBLIC_SCHOOL_NEEDS_PARENTS_ASSOCIATION'
  | 'SCHOOL_OWNER_NO_LEY49'
  | 'LEGAL_FORM_NOT_FOR_VERTICAL'
  | 'OWNERSHIP_REQUIRED'
  | 'UNKNOWN_PROVINCE'
  | 'POSTAL_CODE_PROVINCE_MISMATCH'
  | 'SLUG_INVALID'
  | 'SLUG_RESERVED';

/** Campo del formulario al que pertenece cada problema (para colocar el mensaje junto a él). */
export const ISSUE_FIELD: Record<RegistrationIssue, string> = {
  PUBLIC_SCHOOL_NEEDS_PARENTS_ASSOCIATION: 'legalForm',
  SCHOOL_OWNER_NO_LEY49: 'ley49',
  LEGAL_FORM_NOT_FOR_VERTICAL: 'legalForm',
  OWNERSHIP_REQUIRED: 'centerOwnership',
  UNKNOWN_PROVINCE: 'provinceCode',
  POSTAL_CODE_PROVINCE_MISMATCH: 'postalCode',
  SLUG_INVALID: 'slug',
  SLUG_RESERVED: 'slug'
};

export function slugIssue(slug: string): RegistrationIssue | null {
  if (RESERVED_SLUGS.has(slug)) return 'SLUG_RESERVED';
  return !SLUG_PATTERN.test(slug) || slug.includes('--') ? 'SLUG_INVALID' : null;
}

/** Problemas de negocio y legales del alta (los de formato los da `registrationSchema`). */
export function registrationIssues(input: Pick<RegistrationInput, 'vertical' | 'legalForm' | 'centerOwnership' | 'ley49' | 'provinceCode' | 'postalCode' | 'slug'>): RegistrationIssue[] {
  const issues: RegistrationIssue[] = [];
  const school = input.vertical === 'SCHOOL';
  if (school && input.centerOwnership === 'NOT_APPLICABLE') issues.push('OWNERSHIP_REQUIRED');
  if (!LEGAL_FORMS_BY_VERTICAL[input.vertical].includes(input.legalForm)) issues.push('LEGAL_FORM_NOT_FOR_VERTICAL');
  if (school && input.centerOwnership === 'PUBLIC' && input.legalForm !== 'PARENTS_ASSOCIATION') issues.push('PUBLIC_SCHOOL_NEEDS_PARENTS_ASSOCIATION');
  if (input.legalForm === 'SCHOOL_OWNER' && input.ley49) issues.push('SCHOOL_OWNER_NO_LEY49');
  if (!provinceByCode(input.provinceCode)) issues.push('UNKNOWN_PROVINCE');
  else if (input.postalCode.slice(0, 2) !== input.provinceCode) issues.push('POSTAL_CODE_PROVINCE_MISMATCH');
  const slug = slugIssue(input.slug);
  if (slug) issues.push(slug);
  return [...new Set(issues)];
}

/** Titularidad que se guarda: fuera de los colegios no aplica. */
export const ownershipFor = (input: Pick<RegistrationInput, 'vertical' | 'centerOwnership'>) => (input.vertical === 'SCHOOL' ? input.centerOwnership : 'NOT_APPLICABLE');

/** Plantilla oficial de grupos del vertical (Regla 03 §5); la entidad podrá editarla desde su panel. */
export function participationTemplate(vertical: (typeof VERTICALS)[number]): ParticipationGroupCluster[] {
  const template = vertical === 'SCHOOL' ? OFFICIAL_SCHOOL_13_COURSES : vertical === 'SPORTS_CLUB' ? OFFICIAL_SPORTS_CLUB_GROUPS : OFFICIAL_CULTURAL_GROUPS;
  return template.map((cluster) => ({ group: cluster.group, items: [...cluster.items] }));
}
