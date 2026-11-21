import type { ReactNode } from 'react';
import { legalPathOf, resolveLegalLink, type LegalLocale } from '@/core/legal/legal-catalog';
import { plainText, type LegalBlock, type LegalInline } from '@/core/legal/legal-markdown';
import { Link } from '@/i18n/navigation';

/**
 * Pinta un texto legal ya leído (`parseLegalMarkdown`) con elementos de React: nada se inserta como HTML. Los enlaces entre documentos llevan a la página pública
 * de cada uno en el idioma de la página; un enlace a un documento interno o que no se reconoce se queda en texto. Las tablas se desplazan en horizontal dentro de
 * su propia región en el móvil (la página no se ensancha).
 */

const LINK = 'font-semibold text-varsity-navy underline underline-offset-4 wrap-anywhere';

function Inline({ nodes, locale }: { nodes: readonly LegalInline[]; locale: LegalLocale }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return node.value;
      case 'strong':
        return (
          <strong key={index} className="font-bold text-ink">
            <Inline nodes={node.children} locale={locale} />
          </strong>
        );
      case 'em':
        return (
          <em key={index}>
            <Inline nodes={node.children} locale={locale} />
          </em>
        );
      case 'code':
        return (
          <code key={index} className="rounded bg-varsity-navy/5 px-1 font-mono text-[0.9em]">
            {node.value}
          </code>
        );
      case 'link': {
        const target = resolveLegalLink(node.href);
        const children = <Inline nodes={node.children} locale={locale} />;
        if (target.kind === 'document')
          return (
            <Link key={index} href={`${legalPathOf(target.document)}${target.hash}`} className={LINK}>
              {children}
            </Link>
          );
        if (target.kind === 'page')
          return (
            <Link key={index} href={target.path} className={LINK}>
              {children}
            </Link>
          );
        if (target.kind === 'external')
          return (
            <a key={index} href={target.href} rel="noopener noreferrer" className={LINK}>
              {children}
            </a>
          );
        return <span key={index}>{children}</span>;
      }
    }
  });
}

const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'font-corp text-3xl font-extrabold leading-tight text-varsity-navy sm:text-4xl',
  2: 'font-corp mt-4 scroll-mt-24 text-2xl font-extrabold text-varsity-navy',
  3: 'font-corp mt-2 scroll-mt-24 text-xl font-bold text-varsity-navy',
  4: 'font-corp scroll-mt-24 text-lg font-bold text-varsity-navy'
};

function Block({ block, locale, tableLabel }: { block: LegalBlock; locale: LegalLocale; tableLabel: string }): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as const;
      return (
        <Tag id={block.level === 1 ? undefined : block.id} className={HEADING_CLASS[block.level]}>
          <Inline nodes={block.inline} locale={locale} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p>
          <Inline nodes={block.inline} locale={locale} />
        </p>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Inline nodes={item.inline} locale={locale} />
          {item.children.length > 0 ? <Blocks blocks={item.children} locale={locale} tableLabel={tableLabel} className="mt-2 flex flex-col gap-2" /> : null}
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className="flex list-decimal flex-col gap-2 ps-6">
          {items}
        </ol>
      ) : (
        <ul className="flex list-disc flex-col gap-2 ps-6">{items}</ul>
      );
    }
    case 'table': {
      const caption = block.header.map(plainText).filter((text) => text.trim() !== '').join(' · ');
      return (
        <div tabIndex={0} role="region" aria-label={`${tableLabel}: ${caption}`} className="overflow-x-auto rounded-xl border-2 border-varsity-navy/15">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead className="bg-varsity-navy/5 text-varsity-navy">
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} scope="col" className="p-2 align-top font-bold">
                    <Inline nodes={cell} locale={locale} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-varsity-navy/10">
                  {row.map((cell, index) => (
                    <td key={index} className="p-2 align-top">
                      <Inline nodes={cell} locale={locale} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'quote':
      return (
        <blockquote className="flex flex-col gap-2 border-s-4 border-varsity-navy/30 bg-varsity-navy/5 px-4 py-3">
          <Blocks blocks={block.blocks} locale={locale} tableLabel={tableLabel} className="flex flex-col gap-2" />
        </blockquote>
      );
    case 'rule':
      return <hr className="border-varsity-navy/15" />;
  }
}

export function Blocks({ blocks, locale, tableLabel, className }: { blocks: readonly LegalBlock[]; locale: LegalLocale; tableLabel: string; className?: string }) {
  return (
    <div className={className ?? 'flex flex-col gap-4 leading-relaxed text-ink'}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} locale={locale} tableLabel={tableLabel} />
      ))}
    </div>
  );
}
