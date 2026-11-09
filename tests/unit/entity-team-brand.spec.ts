import { describe, expect, it } from 'vitest';
import { accentByHex, accentById, contrastRatio, ENTITY_ACCENTS, NAVY } from '@/core/brand/entity-palette';
import { GROUP_LIMITS, groupIssues, participationGroupsSchema, toStoredGroups } from '@/core/panel/participation-groups-rules';
import { handoverProposalSchema, maskEmail, ownRoleLabelSchema } from '@/core/panel/team-rules';
import { heroBackground, monogram, safeImageSrc } from '@/components/portal/entity-crest';
import { OFFICIAL_CULTURAL_GROUPS, OFFICIAL_SCHOOL_13_COURSES, OFFICIAL_SPORTS_CLUB_GROUPS } from '@/types/korum.types';

/**
 * Sprint 4.2e · reglas puras del equipo que firma, los grupos de participación y la identidad visual: la paleta cerrada mantiene el contraste del portal,
 * los grupos no repiten identificador ni llevan enlaces, el email de la persona invitada sale a medias y la cabecera solo pinta imágenes propias.
 */

describe('paleta cerrada de la entidad', () => {
  it('cada color tiene al menos 3:1 con el azul marino de la cabecera (WCAG 1.4.11) y su identificador es único', () => {
    expect(ENTITY_ACCENTS).toHaveLength(8);
    for (const accent of ENTITY_ACCENTS) expect(contrastRatio(accent.hex, NAVY), accent.id).toBeGreaterThanOrEqual(3);
    expect(new Set(ENTITY_ACCENTS.map((accent) => accent.id)).size).toBe(8);
    expect(new Set(ENTITY_ACCENTS.map((accent) => accent.hex)).size).toBe(8);
  });

  it('el texto blanco sobre el azul marino pasa de 4.5:1 y la relación es simétrica', () => {
    expect(contrastRatio('#FFFFFF', NAVY)).toBeGreaterThan(15);
    expect(contrastRatio(NAVY, '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', NAVY), 10);
  });

  it('reconoce un color guardado sin importar mayúsculas y descarta los que no son de la paleta', () => {
    expect(accentByHex('#ff5a43')?.id).toBe('coral');
    expect(accentByHex(' #10B981 ')?.id).toBe('emerald');
    expect(accentByHex('#101F38')).toBeNull();
    expect(accentById('sky')?.hex).toBe('#38BDF8');
    expect(accentById('#38BDF8')).toBeNull();
  });
});

describe('cabecera de la entidad', () => {
  it('solo pinta imágenes servidas por /api/files/public: nunca una URL ajena ni algo que rompa el estilo', () => {
    expect(safeImageSrc('/api/files/public/clx0123456789abcdefghij')).toBe('/api/files/public/clx0123456789abcdefghij');
    for (const bad of ['https://otra.web/logo.png', '/api/files/public/../../secret', '/api/files/public/abc") ; background:url(x', 'javascript:alert(1)', null, undefined]) expect(safeImageSrc(bad)).toBeNull();
  });

  it('con portada pone un velo azul marino del 86 % por encima; sin ella, solo el brillo y el borde del color', () => {
    const withBanner = heroBackground('#F59E0B', '/api/files/public/clx0123456789abcdefghij');
    expect(withBanner.backgroundImage).toContain('rgba(16, 31, 56, 0.86)');
    expect(withBanner.backgroundImage).toContain('url("/api/files/public/clx0123456789abcdefghij")');
    expect(withBanner.borderBottom).toBe('6px solid #F59E0B');
    const plain = heroBackground('rojo', 'https://otra.web/foto.jpg');
    expect(plain.backgroundImage).not.toContain('url(');
    expect(plain.borderBottom).toBe('6px solid #f59e0b');
  });

  it('sin logotipo, las iniciales: hasta dos letras y sin símbolos', () => {
    expect(monogram('CEIP Cervantes')).toBe('CC');
    expect(monogram('Club Deportivo Águilas del Sur')).toBe('CD');
    expect(monogram('#1 AMPA')).toBe('A');
  });
});

describe('grupos de participación', () => {
  it('las tres plantillas oficiales se pueden guardar tal cual', () => {
    for (const template of [OFFICIAL_SCHOOL_13_COURSES, OFFICIAL_SPORTS_CLUB_GROUPS, OFFICIAL_CULTURAL_GROUPS]) {
      expect(participationGroupsSchema.safeParse({ blocks: template }).success).toBe(true);
      expect(groupIssues(template)).toEqual([]);
    }
  });

  it('dos nombres con el mismo identificador de enlace, un nombre sin letras o demasiados grupos no se guardan', () => {
    expect(groupIssues([{ group: 'Primaria', items: ['3º de Primaria', '3º Primaria'] }])).toEqual([{ code: 'DUPLICATE', names: ['3º de Primaria', '3º Primaria'] }]);
    expect(groupIssues([{ group: 'A', items: ['Sénior'] }, { group: 'B', items: ['senior'] }])).toEqual([{ code: 'DUPLICATE', names: ['Sénior', 'senior'] }]);
    expect(groupIssues([{ group: 'Raros', items: ['★★★'] }])).toEqual([{ code: 'EMPTY_SLUG', name: '★★★' }]);
    const many = Array.from({ length: 4 }, (_, block) => ({ group: `Bloque ${block}`, items: Array.from({ length: 16 }, (_, item) => `Grupo ${block}-${item}`) }));
    expect(groupIssues(many)).toEqual([{ code: 'TOO_MANY', total: 64 }]);
  });

  it('rechaza enlaces, emails, bloques vacíos y campos de más; limpia los espacios', () => {
    const reject = (blocks: unknown) => participationGroupsSchema.safeParse({ blocks }).success;
    expect(reject([{ group: 'Primaria', items: ['Visita www.ejemplo.com'] }])).toBe(false);
    expect(reject([{ group: 'Escríbenos a ampa@cole.es', items: ['1º'] }])).toBe(false);
    expect(reject([{ group: 'Primaria', items: [] }])).toBe(false);
    expect(reject([])).toBe(false);
    expect(reject(Array.from({ length: GROUP_LIMITS.blocks + 1 }, (_, index) => ({ group: `B${index}`, items: ['x'] })))).toBe(false);
    expect(participationGroupsSchema.safeParse({ blocks: [{ group: 'A', items: ['1'], color: 'red' }] }).success).toBe(false);
    expect(toStoredGroups([{ group: '  Infantil ', items: [' I3 ', 'I4'] }])).toEqual([{ group: 'Infantil', items: ['I3', 'I4'] }]);
  });
});

describe('equipo que firma', () => {
  it('el email de la persona invitada sale a medias: lo justo para reconocerla', () => {
    expect(maskEmail('marta.gil@gmail.com')).toBe('ma•••@gmail.com');
    expect(maskEmail('jo@cole.es')).toBe('j•••@cole.es');
    expect(maskEmail('a@b.es')).toBe('•••@b.es');
    expect(maskEmail('sin-arroba')).toBe('•••');
  });

  it('la propuesta de relevo pide nombre, email y cargo sin enlaces, y solo para los dos puestos que firman', () => {
    const ok = handoverProposalSchema.safeParse({ role: 'COSIGNER', name: 'Marta Gil', email: ' Marta.Gil@Gmail.com ', roleLabel: 'Tesorería del AMPA' });
    expect(ok.success && ok.data.email).toBe('marta.gil@gmail.com');
    expect(handoverProposalSchema.safeParse({ role: 'GATEKEEPER', name: 'Marta Gil', email: 'm@cole.es', roleLabel: 'Portería' }).success).toBe(false);
    expect(handoverProposalSchema.safeParse({ role: 'DIRECTOR', name: 'Marta Gil', email: 'm@cole.es', roleLabel: 'Entra en https://falso.example' }).success).toBe(false);
    expect(handoverProposalSchema.safeParse({ role: 'DIRECTOR', name: 'Marta Gil', email: 'no-es-un-email', roleLabel: 'Dirección' }).success).toBe(false);
    expect(ownRoleLabelSchema.safeParse({ roleLabel: 'Presidencia del AMPA' }).success).toBe(true);
    expect(ownRoleLabelSchema.safeParse({ roleLabel: 'P' }).success).toBe(false);
  });
});
