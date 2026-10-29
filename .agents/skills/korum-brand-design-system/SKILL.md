---
name: korum-brand-design-system
description: >-
  Sistema de Identidad Corporativa y Arquitectura Visual Híbrida de KORUM ("Varsity Heritage Colegial +
  Cuaderno Vivo de Patio"). Define el logotipo oficial colegial universitario ("Escudo Varsity Heritage"
  inspirado en Stanford/Yale/Santa Isabel), activos SVG oficiales en public/brand/, sellos de mérito escolar,
  y la interacción nostálgica de libreta de anillas, pósits y sellos de goma para familias y colegios.
---

# Skill · Identidad Colegial y Sistema Visual Híbrido de KORUM (`v8.5 Hybrid Varsity & Notebook`)

## 1. Principio Rector: Solidez Colegial sin Frialdad Bancaria

KORUM resuelve una tensión psicológica clave en comunidades escolares y deportivas: **las familias y los colegios rechazan instintivamente que su comunidad se sienta como un banco frío o una startup fintech impersonal**. La confianza para aportar dinero nace del **arraigo y el orgullo del propio colegio**: el escudo bordado en la sudadera de uniforme (*varsity hoodie*), el chándal de gimnasia de los martes, la libreta de notas, las pegatinas troqueladas y los sellos entintados de los profesores.

Opera bajo la **Solución Híbrida Oficial**:

### Capa 1 · Identidad Institucional y Solidez Colegial ("Varsity Heritage")
Inspirada en el orgullo de las sudaderas y chaquetas universitarias de Stanford, Yale y colegios de referencia en España (*Reial Monestir de Santa Isabel*, *Pare Manyanet*):
- **Dónde aplica:** Logotipo oficial de KORUM, cabeceras institucionales, custodia Escrow, pases QR oficiales, certificados y documentos de liquidación.
- **Logotipo Oficial (*Escudo Varsity Heritage*):**
  - Escudo colegial bordado en hilo pesado sobre tejido azul marino de sudadera escolar (`#101F38`).
  - Letra **"K"** en tipografía universitaria de serifa plana (*Collegiate Slab Serif*) con doble perfil interior calado en hilo de oro mostaza deportivo (`#F59E0B`), pespunte perimetral discontinuo de aguja.
  - Corona de **laureles cívicos bordados** (simbolizando el quórum y la unión de la comunidad) y cinta conmemorativa inferior *"EST. 2026 · QUÓRUM ESCOLAR"*.
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

## 2. Inventario Oficial de Activos de Marca (`public/brand/`)

Todos los activos oficiales están consolidados en `public/brand/`, archivando versiones preliminares en `public/brand/_old/`:

1. `public/brand/korum-logo.svg` ➔ Lockup horizontal oficial (Escudo Varsity Heritage + KORUM colegial + subtítulo en oro deportivo).
2. `public/brand/korum-mark.svg` ➔ Escudo Varsity Heritage aislado para favicons, avatares y centro de códigos QR.
3. `public/brand/korum-logo-dark.svg` ➔ Lockup horizontal optimizado para fondos oscuros.
4. `public/brand/korum-escrow-seal.svg` ➔ Sello colegial de custodia (*"CUSTODIA ESCOLAR MANCOMUNADA · 100% GARANTÍA"*).
5. `public/brand/korum-cuaderno-stamp.svg` ➔ Sello entintado de aprobación escolar para el Buzón de Ideas y Logros.
6. `public/brand/korum-varsity-crest.svg` ➔ Escudo heráldico universitario bordado en vector puro.
7. `public/brand/korum-logo.jpg` ➔ Lámina maestra fotorrealista en alta resolución del parche de sudadera bordada.
8. `public/brand/korum-cuaderno-vivo.jpg` ➔ Lámina maestra del cuaderno escolar, sellos de caucho y notas de familias.
9. `public/brand/korum-hero-patio.jpg` y `korum-notebook-stickers.jpg` ➔ Recursos de ambientación comunitaria de patio.
10. `public/brand/_old/` ➔ Repositorio histórico donde se preservan intactas las propuestas bancarias previas y descartadas:
    - `_old/fase1_banco_corporativo/`: Logotipos y propuestas de la fase bancaria inicial.
    - `_old/fase2_propuestas_descartadas/`: Propuesta atlética de chándal descartada como marca primaria.

---

## 3. Reglas de Co-Branding Multi-Tenant (`Colegio/Club × KORUM`)

- En cabeceras públicas de centro (`/[orgSlug]`), carteles A4 y entradas QR, el protagonismo emocional lo lleva el nombre y escudo del Colegio/Club, acompañado del sello institucional **`Respaldado por KORUM Escrow`** con el isotipo `korum-mark.svg`, transmitiendo a las familias que el centro lidera el sueño y **KORUM blinda el dinero**.
- Respeta siempre el blindaje móvil `430px` (`.mobile-stack`, `scrollWidth <= 430`): ningún logotipo, sello fiduciario ni pegatina decorativa puede provocar desbordamiento horizontal en pantallas móviles.
