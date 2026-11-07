import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QA-F08 (`DISABLED`) · Mi Hucha no existe si el Super-Admin la desactiva: el `layout` responde 404 antes de que el esqueleto de carga envíe un
 * `200`. Se prueba aquí, con el ajuste simulado, porque cambiarlo en la base de las pruebas E2E afectaría a las que corren en paralelo.
 */

const mode = { value: 'PLEDGE' as string | undefined };

vi.mock('@/lib/prisma', () => ({ getPrisma: () => ({}) }));
vi.mock('@/services/settings/settings.service', () => ({ getSetting: async () => mode.value }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  }
}));

const { default: HuchaLayout } = await import('@/app/[locale]/(account)/mi-hucha/layout');

describe('Mi Hucha según el modo', () => {
  beforeEach(() => {
    mode.value = 'PLEDGE';
  });

  it('con DISABLED (o sin valor) no existe: 404', async () => {
    mode.value = 'DISABLED';
    await expect(HuchaLayout({ children: 'contenido' })).rejects.toThrow('NOT_FOUND');
    mode.value = undefined;
    await expect(HuchaLayout({ children: 'contenido' })).rejects.toThrow('NOT_FOUND');
  });

  it('con PLEDGE (y con el monedero, que explica que llegará) se abre', async () => {
    await expect(HuchaLayout({ children: 'contenido' })).resolves.toBe('contenido');
    mode.value = 'REGULATED_WALLET';
    await expect(HuchaLayout({ children: 'contenido' })).resolves.toBe('contenido');
  });
});
