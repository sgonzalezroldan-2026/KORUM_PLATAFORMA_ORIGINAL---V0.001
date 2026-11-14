# Especificación Técnica de Tokens Visuales y Geometría SVG · KORUM Brand System v8.5
## Arquitectura Híbrida Oficial: "Varsity Heritage Colegial + Cuaderno Vivo de Patio"

---

## 1. Paleta Cromática Dual Oficial (`Tailwind` + CSS Custom Properties)

| Rol / Capa | Token | Hexadecimal | Uso Estricto |
| :--- | :--- | :--- | :--- |
| **Capa 1 · Sudadera Colegial** | `varsity.navy` | `#101F38` / `#0A1424` | Fondo de escudo bordado, cabecera institucional, wordmark `KORUM` sobre claro y Consola Super-Admin. |
| **Capa 1 · Oro Deportivo Bordado** | `varsity.gold` | `#F59E0B` / `#D97706` | Anillo exterior, laureles, relleno de la letra K colegial y cinta con la palabra KORUM. |
| **Capa 1 · Hilo Marfil** | `varsity.ivory` | `#FDFBF7` | Contorno de la letra K universitaria, fino anillo del parche, ribetes de uniforme y texto en fondos oscuros. |
| **Capa 1 · Hucha de la iniciativa** | `varsity.emerald` | `#047857` / `#10B981` | Check de firma mancomunada, hucha `WLT-ESC-XXX`, certificados IRPF y validación QR. |
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

## 4. Geometría Vectorial del Isotipo: *"Parche Varsity Heritage"* (`viewBox="0 0 100 100"`)

Se dibuja a partir de la lámina de referencia `docs/brand/korum-logo.jpg` (componente `KorumMark`):

- **Base de parche redondo:** círculo de radio 46 relleno con paño azul marino de sudadera pesada (`#101F38`).
- **Anillos:** anillo exterior de oro deportivo (`#F59E0B`, trazo ≈ 4) y, por dentro, un fino anillo marfil (`#FDFBF7`, trazo ≈ 1,2) con una separación de azul marino.
- **Pespunte bordado de aguja:** línea discontinua (`stroke-dasharray="3.5, 2"`) en oro oscuro (`#D97706`) pegada al borde interior del anillo exterior. Es solo decoración: se omite por debajo de 24 px.
- **Laureles:** dos ramas simétricas de 6 a 7 hojas (oro `#F59E0B` y marfil alternados) que abrazan la K por los lados.
- **Letra 'K' universitaria:** serifa plana gruesa (*Collegiate Slab Serif*) **rellena de oro** (`#F59E0B`) con **contorno marfil** (`#FDFBF7`, trazo ≈ 2,5) y una sombra de hilo (`#D97706`) a la derecha.
- **Cinta inferior:** cinta curva dorada con la palabra `KORUM` en azul marino. **Sin año y sin subtítulo** (ver `SKILL.md` §1 y §5).
- **Tamaños:** funciona legible desde 16 px (favicon): por debajo de 32 px se simplifica a círculo + K + anillo (sin laureles ni cinta).
