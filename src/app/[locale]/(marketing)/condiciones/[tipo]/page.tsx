import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalDocumentPage, legalPageMetadata, type LegalPageProps } from '@/components/legal/legal-document-page';
import { CONDITIONS_BY_SLUG } from '@/core/legal/legal-catalog';

/** Condiciones de cada servicio (Sprint 5.10a): entradas y vales, aportación mensual, entidades y comercios. Un tipo que no existe da 404. */
type Props = LegalPageProps & { params: Promise<{ locale: string; tipo: string }> };

const documentOf = async (params: Props['params']) => CONDITIONS_BY_SLUG[(await params).tipo];

export async function generateMetadata(props: Props): Promise<Metadata> {
  const document = await documentOf(props.params);
  return document ? legalPageMetadata(document, props) : {};
}

export default async function ConditionsPage(props: Props) {
  const document = await documentOf(props.params);
  if (!document) notFound();
  return <LegalDocumentPage document={document} {...props} />;
}
