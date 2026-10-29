import type { ReactNode } from 'react';

// El <html> lo pinta app/[locale]/layout.tsx para poder fijar el atributo `lang` por idioma.
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
