# Landing, acceso por rol y alta de entidades · KORUM

> **Propósito:** definir el **Entorno 0** de KORUM: la web comercial (`korum.app`), que capta entidades, familias y comercios de forma autónoma y bien posicionada en buscadores y asistentes de IA, y la puerta de acceso segura para cada rol. SEO y vista previa en redes: [korum-seo-discoverability](../.agents/skills/korum-seo-discoverability/SKILL.md).

---

## 1. Web de marketing (`src/app/[locale]/(marketing)/...`, en es, ca y en)

### 1.1 Portada (`/`)

Diseño dual de la [skill de marca](../.agents/skills/korum-brand-design-system/SKILL.md): **solidez colegial** (escudo *Varsity Heritage*, azul marino y oro) en lo institucional y **emoción de patio** en lo comunitario, sin estética de banco. Convierte a tres públicos: entidades (dirección, AMPA/AFA, clubes), familias y comercios.

1. **Hero con doble llamada a la acción:**
   - **Titular:** *"Donde las buenas ideas de tu colegio o club suman y se hacen realidad."*
   - **Subtítulo:** *"La plataforma independiente para que tu comunidad proponga, decida y financie mejoras: campañas todo o nada con devolución automática si no se llega a la meta, taquilla digital con QR y libertad total para elegir proveedor. Sin cuota de alta y sin manejar efectivo."*
   - **Principal (entidades):** `🏫 Dar de alta mi colegio, AMPA o club gratis` → `/registro-comunidad`.
   - **Secundaria (familias):** `🔍 Buscar mi colegio o club` (por nombre, ciudad o código postal) + `🔐 Iniciar sesión`.
2. **Calculadora de impacto:** tipo de entidad, número de familias o socios y objetivo (climatización, sombra en el patio, pizarras digitales, marcador LED, viaje de fin de curso). Muestra cómo, con una aportación media de 15–25 € y unos pocos comercios del barrio, se alcanza la meta, destacando los primeros `1.000 €` sin comisión. Las cifras son orientativas y se dice así.
3. **Cómo funciona en 4 pasos:** `1. Proponed y sumad firmas` ➔ `2. Doble firma de la entidad (con vuestro proveedor)` ➔ `3. Las familias aportan en 10 s con Bizum (todo o nada)` ➔ `4. Disfrutad del Antes y Después`.
4. **Pestañas por público:**
   - **Entidades:** sin efectivo, doble firma mancomunada, pago directo a la entidad o a su proveedor, Modelo 182 automático (entidades con Ley 49/2002), modo portería QR y medallas anuales.
   - **Familias:** aportar en 10 s, devolución automática del 100 % si no se llega a la meta, retos por curso o equipo y entradas QR en el móvil.
   - **Comercios:** visibilidad ante las familias del barrio como comercio ORO, PLATA o BRONCE, con factura al momento.
5. **Logros reales y transparencia:** galería Antes/Después y una sección de *cómo funciona el dinero* en lenguaje llano: *"Los pagos los procesa PAYCOMET, entidad de pago autorizada por el Banco de España. KORUM es la tecnología: no guarda vuestro dinero."* (redacción exacta aprobada por Paycomet). **Sin sellos ni logotipos de organismos públicos ni textos que presenten a KORUM como entidad regulada.**

### 1.2 Páginas pilar (SEO)

`/para-colegios`, `/para-clubes`, `/para-entidades-culturales`, `/para-comercios`, `/como-funciona`, `/precios`, `/seguridad-y-transparencia`, `/preguntas-frecuentes` y `/guias/*` (p. ej. *"Cómo financiar la climatización del colegio"*, *"Cómo organizar una rifa solidaria legal"*). Cada una responde a su pregunta principal en el primer párrafo, en los tres idiomas.

---

## 2. Acceso por rol (`src/app/[locale]/(auth)/...`)

| Rol | Entrada | Método | Cuándo es obligatorio |
| :--- | :--- | :--- | :--- |
| **1. Familia, socio o vecino** | `/login` o modal dentro de `/[orgSlug]` | **Sin contraseña:** enlace mágico u OTP de 6 dígitos (email canónico); opcionalmente passkey | **No** para aportar ni comprar entradas (solo email). **Sí** para firmar o proponer ideas, Mi Hucha y Mi cuenta. |
| **2. Comercio** | Checkout de patrocinio o `/login` | Alta automática al patrocinar + enlace mágico al email de facturación | Para editar su logo y su ventaja, descargar facturas o gestionar la renovación. |
| **3. Firmantes de la entidad (`DIRECTOR` y `COSIGNER`)** | `/registro-comunidad` (alta) y `/login` → `/panel/[orgSlug]` | **Email + contraseña + 2FA obligatoria** (y enlace de un solo uso + OTP para firmar desde el móvil) | Siempre. Las **dos firmas de dos personas distintas** son necesarias para aprobar ideas y liberar fondos. |
| **4. Voluntario de portería** | `/panel/[orgSlug]/porteria` | **PIN de 6 dígitos del evento**, con caducidad y límite de intentos | Solo escáner y sorteo de ese evento; sin acceso a datos bancarios, fiscales ni personales. |
| **5. Super-Admin** | `/login` → `/admin` | **Contraseña + 2FA obligatoria** (passkey recomendada) | Toda la ruta `/admin/*`, con registro de auditoría. |

En producción **no existe** la barra de demostración del prototipo (selector de entornos, perfiles simulados y conmutador web/móvil): solo en el entorno de demostración con `NEXT_PUBLIC_DEMO_MODE=true`.

---

## 3. Alta autónoma de una entidad (`/registro-comunidad`)

Tres pasos, sin intervención humana:

1. **Comunidad y titular legal:**
   - Vertical (`SCHOOL`, `SPORTS_CLUB`, `CULTURAL`), nombre público y provincia.
   - **Titular de los fondos:** razón social, forma jurídica (AMPA/AFA, titular de colegio privado o concertado, fundación, club o entidad deportiva, asociación cultural, otra sin ánimo de lucro) y, en colegios, titularidad del centro (público, concertado, privado). **Un colegio público solo puede darse de alta a través de su AMPA/AFA.**
   - Régimen Ley 49/2002 (sí/no; si es sí, se acredita en el KYB).
   - Idioma en que redactará sus campañas, si quiere aparecer en buscadores (`publicIndexing`) y URL propia (`korum.app/cervantes`). Se carga su plantilla de cursos, equipos o grupos.
2. **Firmantes de la doble firma:** email, teléfono y cargo de la persona `DIRECTOR` y de la persona `COSIGNER` (invitación automática al segundo firmante, que debe activar su cuenta con 2FA).
3. **Activación con `1.000 €` exentos:** acceso inmediato a `/panel/[orgSlug]` para abrir el buzón de ideas o preparar campañas con plantillas. Los **documentos KYB** (CIF, estatutos o acta, DNI del representante y certificado de titularidad del IBAN, más la acreditación de Ley 49/2002 si procede) se suben de forma privada y son obligatorios **antes de publicar** la primera campaña con cobro.
