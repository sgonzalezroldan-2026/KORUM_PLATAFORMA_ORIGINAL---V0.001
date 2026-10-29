import { notFound } from 'next/navigation';

// Cualquier ruta sin página propia cae aquí para mostrar el 404 con el idioma y la cabecera de KORUM.
export default function CatchAllPage() {
  notFound();
}
