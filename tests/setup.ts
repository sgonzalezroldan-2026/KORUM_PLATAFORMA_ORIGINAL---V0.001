import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { cancelPendingFocus } from '@/lib/focus-later';

afterEach(() => {
  cleanup();
  // Una devolución de foco que siguiera esperando a su destino no debe enfocar un elemento de la prueba siguiente (fallo del CI de GitHub, Sprint 5.6).
  cancelPendingFocus();
});
