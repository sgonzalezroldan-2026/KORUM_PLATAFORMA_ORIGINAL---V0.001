import { afterEach, describe, expect, it, vi } from 'vitest';
import UiGalleryPage from '@/app/[locale]/(dev)/dev/ui/page';

// La página lee el entorno al ejecutarse (no al importarse), así que se importa una vez y se simula el entorno en cada caso.
// No se reinician módulos: React elige su versión de desarrollo o producción al cargarse y sin `jsxDEV` no se puede renderizar.
describe('la galería interna de componentes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('en producción real (sin modo demostración) responde 404', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
    let thrown: unknown;
    try {
      UiGalleryPage();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ digest: expect.stringContaining('404') });
  });

  it('en producción con modo demostración se muestra', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    expect(UiGalleryPage()).toBeTruthy();
  });

  it('en desarrollo se muestra', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(UiGalleryPage()).toBeTruthy();
  });
});
