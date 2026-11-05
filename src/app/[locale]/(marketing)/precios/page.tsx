import { PillarPage, pillarMetadata, type PillarProps } from '@/components/marketing/pillar-page';

// Las tarifas salen de la consola: la página se vuelve a generar cada 10 minutos.
export const revalidate = 600;

export const generateMetadata = (props: PillarProps) => pillarMetadata('precios', props);

export default function Page(props: PillarProps) {
  return <PillarPage pageKey="precios" {...props} />;
}
