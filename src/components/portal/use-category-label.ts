import { useTranslations } from 'next-intl';
import { standardCategoryKey } from '@/core/public/category-label';

/**
 * Cómo enseñar una categoría de campaña: las estándar, traducidas al idioma de la página; las que la entidad ha creado, tal como las escribió y con el
 * idioma de su contenido (`lang`), que es el que se declara para los lectores de pantalla.
 */
export function useCategoryLabel(contentLang?: string): (name: string) => { text: string; lang: string | undefined } {
  const t = useTranslations('portal.categories');
  return (name) => {
    const key = standardCategoryKey(name);
    return key === null ? { text: name, lang: contentLang } : { text: t(key), lang: undefined };
  };
}
