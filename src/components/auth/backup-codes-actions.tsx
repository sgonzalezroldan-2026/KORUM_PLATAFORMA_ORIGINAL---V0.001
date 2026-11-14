'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { secondaryButton } from './auth-ui';

/**
 * Guardar los códigos de respaldo del segundo factor (Sprint 5.5b, heredado del 3.2): copiarlos, imprimirlos o descargarlos en un `.txt`. Todo ocurre en el
 * navegador: los códigos no viajan a ningún sitio más. Al imprimir solo sale la hoja de los códigos (`html.korum-print-backup`, en `globals.css`), no la
 * pantalla entera con el secreto del QR.
 */

/** Texto del fichero y del portapapeles: un código por línea, con una cabecera que dice qué son. */
export function backupCodesText(title: string, intro: string, codes: readonly string[]): string {
  return [title, intro, '', ...codes].join('\n') + '\n';
}

/** Identificador de la hoja que se imprime (la regla de impresión de `globals.css` lo nombra). */
export const BACKUP_SHEET_ID = 'korum-backup-sheet';

export function BackupCodesActions({ codes }: { codes: readonly string[] }) {
  const t = useTranslations('auth.twoFactor');
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const text = backupCodesText(t('backupFileTitle'), t('backupFileIntro'), codes);

  useEffect(() => {
    const done = () => document.documentElement.classList.remove('korum-print-backup');
    window.addEventListener('afterprint', done);
    return () => {
      window.removeEventListener('afterprint', done);
      done();
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ text: t('backupCopied'), ok: true });
    } catch {
      setNotice({ text: t('backupCopyFailed'), ok: false });
    }
  };
  const print = () => {
    document.documentElement.classList.add('korum-print-backup');
    window.print();
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'korum-codigos-de-respaldo.txt';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setNotice({ text: t('backupDownloaded'), ok: true });
  };

  const button = `${secondaryButton} sm:w-auto`;
  return (
    <div className="flex flex-col gap-2 print:hidden">
      <div className="mobile-stack grid gap-2 sm:flex sm:flex-wrap">
        <button type="button" className={button} onClick={() => void copy()}>
          <span aria-hidden="true">{'📋 '}</span>
          {t('backupCopy')}
        </button>
        <button type="button" className={button} onClick={print}>
          <span aria-hidden="true">{'🖨️ '}</span>
          {t('backupPrint')}
        </button>
        <button type="button" className={button} onClick={download}>
          <span aria-hidden="true">{'⬇️ '}</span>
          {t('backupDownload')}
        </button>
      </div>
      {/* El color acompaña al texto: verde si salió bien, rojo si no (nunca verde para un fallo). */}
      <p role="status" className={`min-h-5 text-sm font-semibold ${notice?.ok === false ? 'text-red-800' : 'text-varsity-emerald'}`}>
        {notice?.text}
      </p>
    </div>
  );
}
