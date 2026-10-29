# Especificación Técnica de Tokens Visuales y Geometría SVG · KORUM Brand System v8.5
## Arquitectura Híbrida Oficial: "Varsity Heritage Colegial + Cuaderno Vivo de Patio"

---

## 1. Paleta Cromática Dual Oficial (`Tailwind` + CSS Custom Properties)

| Rol / Capa | Token | Hexadecimal | Uso Estricto |
| :--- | :--- | :--- | :--- |
| **Capa 1 · Sudadera Colegial** | `varsity.navy` | `#101F38` / `#0A1424` | Fondo de escudo bordado, cabecera institucional, wordmark `KORUM` sobre claro y Consola Super-Admin. |
| **Capa 1 · Oro Deportivo Bordado** | `varsity.gold` | `#F59E0B` / `#D97706` | Pespunte bordado, laureles cívicos, perfil interior de la letra K colegial y cinta EST. 2026. |
| **Capa 1 · Hilo Marfil** | `varsity.ivory` | `#FDFBF7` | Relleno de fieltro de la letra K universitaria, ribetes de uniforme y texto en fondos oscuros. |
| **Capa 1 · Custodia Escrow** | `varsity.emerald` | `#047857` / `#10B981` | Check de custodia mancomunada en sello, cuenta `WLT-ESC-XXX`, certificados IRPF y validación QR. |
| **Capa 2 · Papel Crema** | `patio.cream` | `#FFFDF8` | Fondo cálido de libreta escolar en portal de Familias y Carteles A4. |
| **Capa 2 · Tinta Roja Escolar** | `patio.stamp` | `#DC2626` / `#FF5A43` | Sellos entintados de mérito (*"¡CONSEGUIDO!"*, *"★ APROBADO EN PATIO"*), margen de libreta y botones cálidos. |
| **Capa 2 · Pauta Cuaderno** | `patio.rule` | `#E2E8F0` / `#CBD5E1` | Líneas guía horizontales de cuaderno escolar y cuadrícula de libreta. |
| **Capa 2 · Washi Tape & Sol** | `patio.tape` | `#FDE047` / `#FFB800` | Tiras adhesivas de sujeción en el Buzón de Ideas y subrayados orgánicos de cera. |

---

## 2. Tipografía Oficial: Separación de Roles

1. **Tipografía Colegial Universitaria (*Collegiate Slab Serif* con doble perfil en marca):**
   - Empleada en el isotipo e imagotipo `KORUM` para dotar de presencia, tradición y solvencia de centro educativo de primer nivel (*Stanford / Yale / Santa Isabel*).
2. **`.font-corp` (`Plus Jakarta Sans`, pesos `700` y `800`, `letter-spacing: -0.02em` en títulos / `tabular-nums`):**
   - Uso obligatorio en: Subtítulos institucionales, importes monetarios en euros, barras de custodia Escrow, Pizarra TCO, Checkout, tablas BI y documentos fiscales/legales.
3. **`.font-joy` (`Fredoka`, pesos `600` y `700`):**
   - Uso exclusivo en: Títulos emocionales de campañas familiares en el patio, nombres de retos de los alumnos y celebraciones de logros.
4. **Cuerpo y Datos (`Plus Jakarta Sans`, pesos `400`, `500`, `600`):**
   - Uso universal en descripciones, formularios, etiquetas y ayudas contextuales.

---

## 3. Clases CSS del Sistema Híbrido (`0 KB` Overhead)

- **`.korum-notebook-sheet`**: Tarjeta blanca con textura de papel pautado escolar (`repeating-linear-gradient(transparent, transparent 27px, #E2E8F0 28px)`), margen vertical coral y sombra de libreta.
- **`.korum-stamp-badge`**: Sello de goma escolar entintado con borde discontinuo (`2px dashed #DC2626`), rotación orgánica (`-2deg`) y aspecto de aprobación de profesor (*"★ Aprobado en Patio · Quórum Logrado"*).
- **`.varsity-patch`**: Contenedor con borde discontinuo dorado (`1.5px dashed #D97706`), fondo marfil y sombra suave de prenda bordada.
- **`.die-cut-sticker`**: Insignia emocional con borde blanco `2.5px`, sombra suave y micro-giro táctil para etiquetas de retos.
- **`.tactile-btn`**: Botón de conversión con relieve físico y respuesta amortiguada al pulsar.

---

## 4. Geometría Vectorial del Isotipo Oficial: *"Escudo Varsity Heritage"* (`viewBox="0 0 100 100"`)

- **Base de Sudadera Escolar:** Silueta heráldica de proporciones clásicas (`M50 6 L82 13 ... V45 C84.5 64 ... 50 86 ... Z`) rellena con paño azul marino de sudadera pesada (`#101F38`).
- **Pespunte Bordado de Aguja:** Línea discontinua perimetral (`stroke-dasharray="3.5, 2"`) en hilo de oro mostaza deportivo (`#F59E0B` ➔ `#D97706`).
- **Laureles Cívicos Colegiales:** Dos ramas de tres hojas bordadas en oro a izquierda y derecha, simbolizando el quórum mancomunado de familias y escuela.
- **Letra 'K' Universitaria:** Doble trazado típico de las sudaderas de gala colegiales: cuerpo de fieltro blanco marfil (`#FDFBF7`) con relieve de hilo y perfil interior calado en oro mostaza.
- **Cinta Conmemorativa:** Cinta curva inferior dorada grabada con *"EST. 2026 · QUÓRUM ESCOLAR"*.
