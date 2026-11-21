import type { Metadata } from 'next';
import { LegalDocumentPage, legalPageMetadata, type LegalPageProps } from '@/components/legal/legal-document-page';

/** Texto legal publicado desde la consola (Sprint 5.10a): la versión vigente y, con `?version=`, una anterior del archivo. */
export function generateMetadata(props: LegalPageProps): Promise<Metadata> {
  return legalPageMetadata('aviso-legal', props);
}

export default function AvisoLegalPage(props: LegalPageProps) {
  return <LegalDocumentPage document="aviso-legal" {...props} />;
}
