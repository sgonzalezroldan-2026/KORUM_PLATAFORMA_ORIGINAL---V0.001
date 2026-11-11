/** Descarga un objeto como archivo JSON desde el navegador (el acta de un sorteo). La dirección temporal se libera con retraso: si se libera al instante, Safari y Firefox pueden abortar la descarga. */
export function downloadJson(fileName: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.replace(/[^\w.-]+/g, '-').slice(0, 80);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
