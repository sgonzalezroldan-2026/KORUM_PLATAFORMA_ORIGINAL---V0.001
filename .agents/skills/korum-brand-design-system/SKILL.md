---
name: korum-brand-design-system
description: >-
  Sistema de Identidad Corporativa y Arquitectura Visual Híbrida de KORUM ("Varsity Heritage Colegial +
  Cuaderno Vivo de Patio"). Define el logotipo de referencia (parche colegial redondo con la K, laureles y
  cinta, lámina docs/brand/korum-logo.jpg), sus componentes SVG en el código, sellos de mérito escolar,
  y la interacción nostálgica de libreta de anillas, pósits y sellos de goma para familias y colegios.
---

# Skill · Identidad Colegial y Sistema Visual Híbrido de KORUM (`v8.5 Hybrid Varsity & Notebook`)

## 1. Principio Rector: Solidez Colegial sin Frialdad Bancaria

KORUM resuelve una tensión psicológica clave en comunidades escolares y deportivas: **las familias y los colegios rechazan instintivamente que su comunidad se sienta como un banco frío o una startup fintech impersonal**. La confianza para aportar dinero nace del **arraigo y el orgullo del propio colegio**: el escudo bordado en la sudadera de uniforme (*varsity hoodie*), el chándal de gimnasia de los martes, la libreta de notas, las pegatinas troqueladas y los sellos entintados de los profesores.

> **Límite de la inspiración:** las referencias a universidades y colegios reales describen un **estilo** (escudo bordado, sudadera *varsity*, cuaderno escolar). Está prohibido reproducir escudos, nombres, lemas, mascotas o combinaciones de color distintivas de instituciones o marcas reales, tanto en activos como en imágenes generadas.

Opera bajo la **Solución Híbrida Oficial**:

### Capa 1 · Identidad Institucional y Solidez Colegial ("Varsity Heritage")
Inspirada en el orgullo de las sudaderas y chaquetas universitarias de Stanford, Yale y colegios de referencia en España (*Reial Monestir de Santa Isabel*, *Pare Manyanet*):
- **Dónde aplica:** Logotipo oficial de KORUM, cabeceras institucionales, custodia Escrow, pases QR oficiales, certificados y documentos de liquidación.
- **Logotipo de referencia (*Escudo Varsity Heritage*), lámina `docs/brand/korum-logo.jpg`:**
  - **Parche redondo** bordado en hilo pesado sobre tejido azul marino de sudadera escolar (`#101F38`), con anillo exterior de oro deportivo (`#F59E0B`) y un fino anillo marfil (`#FDFBF7`).
  - Letra **"K"** en tipografía universitaria de serifa plana (*Collegiate Slab Serif*), rellena de oro y con **contorno marfil**.
  - Dos ramas de **laureles** (quórum y unión de la comunidad) y una **cinta inferior con la palabra `KORUM`**.
  - La lámina incluye un año (*EST. 2023*) y un subtítulo (*SCHOOL PLATFORM*) que **no se llevan a la aplicación**: KORUM sirve también a clubes y entidades culturales, y el logotipo no puede decir «escolar». Si el promotor quiere un lema, lo indica.
  - Proyecta solvencia, prestigio y respeto institucional sin un solo ápice de frialdad bancaria.

### Capa 2 · Experiencia Comunitaria y Emocional ("Cuaderno Vivo de Patio y Sellos de Mérito")
La experiencia de proponer ideas, sumar al curso de los niños y celebrar logros se vive a través de la memoria afectiva escolar:
- **Dónde aplica:** Portada comunitaria, Retos por Curso, **Buzón de Ideas** y **Galería Antes y Después**.
- **Elementos Clave:**
  - **Lienzo de Libreta Escolar:** Fondo crema cálido (`#FFFDF8`) con pauta rayada de cuaderno (`.korum-notebook-sheet`) y margen vertical.
  - **Buzón de Ideas:** Diseñado como un cuaderno escolar de anillas con notas adhesivas (pósits) sujetadas con washi tape y clips metálicos.
  - **Sellos de Mérito Entintados (`.korum-stamp-badge`):** Tampones de goma en tinta roja coral inclinada: *"¡CONSEGUIDO!"*, *"★ APROBADO EN PATIO · QUÓRUM LOGRADO"*.
  - **Pegatinas Troqueladas (`.die-cut-sticker`):** Borde blanco nítido (`3px`) con micro-giro táctil para las categorías y retos.
  - **Retos por Curso:** Tipografía de dorsal universitario (*"3ºB Primaria"*, *"Alevín A"*).

---

## 2. Inventario Oficial de Activos de Marca (`docs/brand/`)

**Activos vigentes en `docs/brand/`** (fuera de `public/` desde el Sprint 5.5b: son láminas de referencia y no se sirven en la web; una imagen que sí se publique va en `public/brand/generated/`; el escáner de invariantes comprueba que todo archivo que esta skill cita existe):

1. `docs/brand/korum-logo.jpg` ➔ **Lámina de referencia del logotipo** (parche de sudadera bordada y su uso en pantallas). Es la guía para dibujar los SVG; no se usa tal cual en la interfaz.
2. `docs/brand/korum-cuaderno-vivo.jpg` ➔ Lámina maestra del cuaderno escolar, sellos de caucho y notas de familias.
3. `docs/brand/korum-hero-patio.jpg` y `korum-notebook-stickers.jpg` ➔ Recursos de ambientación comunitaria de patio.
4. `docs/brand/korum-cuaderno-stamp.svg` ➔ Sello entintado de aprobación escolar para el Buzón de Ideas y Logros.
5. `docs/brand/propuesta_athletic_club_colegial.jpg` ➔ Propuesta alternativa (club atlético, azul y coral). **No es la marca primaria.**

**Componentes de marca en el código** (se dibujan en el Sprint 1.1 a partir de la lámina de referencia, sin año ni subtítulo):

- `src/components/brand/korum-mark-svg.tsx` ➔ `KorumMarkSvg`: el isotipo como SVG **puro, sin hooks ni traducciones** (parche redondo con la K, laureles y cinta con `KORUM`). Es el que se usa donde React no tiene contexto: tarjetas `next/og` (con `variant="simple"`, sin cinta con texto), correos y centro de códigos QR. Hasta 56 px se dibuja simplificado (círculo + K + anillos); la cinta solo se lee por encima.
- `src/components/brand/korum-mark.tsx` ➔ `KorumMark`: envuelve a `KorumMarkSvg` con el nombre accesible y el texto de la cinta traducidos. Favicon: `src/app/icon.svg`.
- `src/components/brand/korum-logo.tsx` ➔ `KorumLogo`: `KorumMark` + wordmark `KORUM`, con variante sobre fondo oscuro. **Provisional:** se sustituye por el vectorial definitivo cuando el promotor lo aporte.

**Descartados (no usar):** todo lo que hay en `docs/brand/_old/` (`fase1_banco_corporativo/` y `fase2_propuestas_descartadas/`, incluidos los SVG antiguos del logotipo, el escudo y el sello de custodia, que decían «QUÓRUM ESCOLAR» y «CUSTODIA»). Se conservan solo como histórico.

---

## 3. Reglas de Co-Branding Multi-Tenant (`Colegio/Club × KORUM`)

- En cabeceras públicas de centro (`/[orgSlug]`), carteles A4 y entradas QR, el protagonismo emocional lo lleva el nombre y escudo del Colegio/Club, acompañado del texto **`Con la tecnología de KORUM`** y el isotipo `KorumMark`. El mensaje para las familias: *el centro lidera el sueño y KORUM pone la tecnología para que el dinero solo se use si se logra la meta* (los cobros los procesa PAYCOMET; KORUM no custodia fondos, ver Regla 03 §4).
- Respeta siempre el blindaje móvil `430px` (`.mobile-stack`, `scrollWidth <= 430`): ningún logotipo, sello o pegatina decorativa puede provocar desbordamiento horizontal en pantallas móviles.

---

## 4. Imágenes: qué genera cada IA y con qué reglas

| Necesidad | Quién la produce | Cómo |
| :--- | :--- | :--- |
| Logotipos, iconos, sellos, pegatinas, ilustraciones planas | **Claude o Gemini** (código) | SVG a mano siguiendo los tokens de este documento |
| Tarjetas para WhatsApp y redes, carteles A4, pases QR | **Claude o Gemini** (código) | `next/og` / componentes React imprimibles |
| Fondos, texturas, fotografías de ambiente, ilustraciones ricas en mapa de bits | **Modelo de imagen de Gemini** | Prompt + revisión humana |
| Retoque o variaciones de una imagen existente | **Modelo de imagen de Gemini** | Edición guiada por prompt |

Reglas para toda imagen generada:

1. **Sin menores identificables.** Niños y niñas solo de espaldas, a contraluz, desenfocados, en ilustración o mediante objetos (mochilas, pupitres, balones). Nunca caras reconocibles.
2. **Sin marcas, escudos ni lugares reales reconocibles.** Nada de logotipos de terceros, uniformes de colegios reales ni fachadas identificables.
3. **Diversidad y contexto español** (familias diversas, patios y pabellones reales de barrio, luz mediterránea), sin estereotipos.
4. **Formato y peso:** exportar a WebP/AVIF (máximo 200 KB en móvil) y conservar el original en `public/brand/generated/originals/`.
5. **Trazabilidad:** junto a cada imagen, un archivo `.md` con el prompt, el modelo, la fecha y el uso previsto.
6. **Texto alternativo** (`alt`) descriptivo en los tres idiomas desde los catálogos de traducción.

---

## 5. Decisiones de marca

1. **Logotipo (cerrada, 29-10-2026):** el de referencia es la lámina `korum-logo.jpg`. Los SVG antiguos (subtítulo *«QUÓRUM ESCOLAR»*) están **descartados**. La aplicación no lleva año ni subtítulo en el logotipo.
2. **Sello de custodia (cerrada, 29-10-2026):** **descartado.** KORUM no custodia fondos ni está regulada, así que no hay sello de custodia ni de garantía propio en la aplicación (coherente con la Regla 03 §4). La garantía se comunica con texto: «el dinero queda retenido en Paycomet hasta lograr la meta».
3. **Paleta del prototipo:** `prototype/Korum_v8.html` usa todavía la paleta de la fase descartada. No se corrige el prototipo (es referencia funcional); la aplicación usa siempre los tokens de este documento.
4. **Abierta, sin urgencia:** lema o subtítulo opcional para el logotipo (p. ej. *«Quórum · Comunidad · Confianza»*). Solo se añade si el promotor lo pide.
