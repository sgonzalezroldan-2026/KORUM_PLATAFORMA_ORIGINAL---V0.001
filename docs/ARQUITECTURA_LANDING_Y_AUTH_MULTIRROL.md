# Arquitectura de la Web de Marketing (Landing Page) y Autenticación Multi-Rol · KORUM

> **Propósito:** Definir el **"Entorno 0"** de KORUM: la web comercial principal (`korum.app`) que actúa como motor autónomo de captación B2B/B2C ("Self-Service Onboarding") y puerta de acceso segura para todos los actores de la plataforma.

---

## 1. Mapa de Rutas Públicas de Marketing y Conversión (`src/app/(marketing)/...`)

### 1.1 Página Principal de Marketing (`/` — Home Comercial de KORUM)
Diseñada con arquitectura visual dual (*Capa Institucional Fiduciaria `corp` para solvencia bancaria + Capa Emocional `patio` para vida escolar/deportiva*, según `.agents/skills/korum-brand-design-system/SKILL.md`) para convertir de forma 100% automatizada a 3 públicos (Direcciones/AFAs/Clubes, Familias y Comercios):
1. **Hero Section con Doble Call-to-Action:**
   - **Titular:** *"Donde las buenas ideas de tu colegio o club suman y se hacen realidad."*
   - **Subtítulo:** *"La plataforma independiente de mecenazgo comunitario con cuentas garantizadas Escrow (Paycomet), quórum auditado y taquilla digital con escáner QR. Sin cuotas fijas, sin manejo de efectivo y con libertad total de proveedores."*
   - **CTA Primario (B2B):** `🏫 Dar de alta mi Colegio / AFA / Club gratis` (lleva a `/registro-comunidad`).
   - **CTA Secundario (B2C):** `🔍 Buscar mi Colegio o Club` (buscador instantáneo por nombre, ciudad o código postal) + botón `🔐 Iniciar Sesión`.
2. **Calculadora Interactiva de Impacto en Vivo (Lead Magnet B2B Autónomo):**
   - El visitante elige tipo de entidad (*Colegio / AFA* o *Club Deportivo*), número estimado de familias/socios (`ej. 400`) y objetivo (*Climatización, Sombra en patios, Pizarras digitales, Marcadores LED, Viaje de estudios*).
   - Muestra al instante cómo con una aportación media de `15 € – 25 €` por familia y `3 comercios amigos del barrio` alcanzan el **100% en menos de 21 días**, destacando los primeros `1.000 € exentos de comisión`.
3. **Sección "Cómo Funciona en 4 Pasos Simples":**
   - `1. Propón y suma firmas (Quórum)` ➔ `2. Doble Firma Dirección + AFA (con vuestro proveedor libre)` ➔ `3. Aporta en 10s con Bizum (Escrow 100% reembolsable)` ➔ `4. Disfruta del Antes y Después`.
4. **Pestañas por Perfil Beneficiado:**
   - **Para Direcciones y AFAs/Juntas:** Cero efectivo, doble firma mancomunada anticrisis, pago directo al proveedor que elija el centro, fichero Modelo 182 AEAT automático en enero (para entidades Ley 49/2002), Modo Portería QR y Kit de Medallas anuales.
   - **Para Familias y Socios:** Donaciones 100% confidenciales en 10s, garantía de devolución automática al medio original si no se logra la meta, retos colectivos por curso/equipo y entradas QR firmadas en el móvil e email.
   - **Para Comercios del Barrio:** Visibilidad anual ante cientos de familias vecinas como Comercio `🥇 Oro`, `🥈 Plata` o `🥉 Bronce` con factura oficial **Veri\*factu** deducible al instante.
5. **Escaparate de Logros Reales y Sellos de Confianza Legal:**
   - Galería interactiva (*Antes y Después*) y sellos de garantía (**Entidad de Pago Regulada Paycomet · PSD2 Banco de España · Exención CNMV Ley 5/2015 · Modelo 182 AEAT · Facturación Veri\*factu · 100% Independencia de Proveedores**).

---

## 2. Arquitectura de Autenticación Multi-Rol y Acceso Portería (`src/app/(auth)/...`)

El sistema gestiona **5 niveles de acceso adaptados a la fricción exacta de cada rol**:

| Rol de Usuario | Ruta de Entrada | Método de Autenticación | Cuándo es Obligatorio Registrarse / Loguearse |
| :--- | :--- | :--- | :--- |
| **1. Familia / Socio / Vecino** | `/login` o modal rápido dentro de `/[orgSlug]` | **Passwordless Magic Link / OTP 6 dígitos** (con normalización `canonicalEmail`) + **Google / Apple Login** | • **NO obligatorio** para donar (`💛 Aportar`) ni comprar entradas QR (solo pide `guestEmail` para enviar recibo/entradas).<br>• **SÍ obligatorio** para: (1) Firmar o proponer ideas en el Buzón (`1 firma/usuario verificado`), y (2) Entrar a `🐷 Mi Hucha` (saldo, recargas, reembolso al origen y certificados fiscales). |
| **2. Comercio Local** | `/[orgSlug]` (`🏪 Colaborar como Comercio`) o `/login-comercio` | Registro automático en Checkout de patrocinio + **Magic Link** al email de facturación | Recibe enlace directo para subir logo, editar su cupón descuento, descargar sus facturas **Veri\*factu** o gestionar su renovación anual. |
| **3. Gestor Mancomunado (`ROLE_DIRECTOR` y `ROLE_AFA_PRESIDENT`)** | `/registro-comunidad` (Alta) y `/login` (`/school/[orgSlug]`) | **Email institucional + Contraseña + 2FA / OTP** (y enlaces firmados OTP para 2ª firma mancomunada en 1 clic) | Obligatorio siempre. Exige **ambas firmas independientes** para aprobar el **Doble Check** de iniciativas y autorizar transferencias de liquidación Escrow (`Split Transfer`). |
| **4. Voluntario de Portería QR (`ROLE_GATEKEEPER`)** | `/school/[orgSlug]/porteria` | **PIN Temporal de Evento de 6 dígitos** (caduca automáticamente tras el evento) | Permite a voluntarios del AFA/Club escanear entradas QR con la cámara del móvil y ejecutar el sorteo de rifas **sin exponerles jamás datos bancarios ni fiscales del panel**. |
| **5. Super-Admin KORUM** | `/admin/login` (`/admin`) | **Credenciales Corporativas + 2FA Obligatorio** | Obligatorio en toda la ruta `/admin/*` con protección estricta en middleware y registro de auditoría. |

---

## 3. Flujo de Onboarding 100% Autónomo ("Zero-Touch") de un Nuevo Colegio o Club (`/registro-comunidad`)

Diseñado para escalar sin coste comercial humano en 3 pasos:

1. **Paso 1 — Datos y Vertical de la Comunidad:**
   - Vertical (`SCHOOL`: Colegio Público/Concertado/Privado o AFA/AMPA · `SPORTS_CLUB`: Club Deportivo Base · `CULTURAL`: Escuela de Música/Asociación), nombre oficial, provincia, régimen fiscal (`Ley 49/2002 / Utilidad Pública` sí/no) y generación instantánea de URL (`korum.app/cervantes`) y plantilla de cursos/equipos.
2. **Paso 2 — Responsables de la Doble Firma Mancomunada:**
   - Email institucional y teléfono de la Dirección/Presidencia y de la Presidencia del AFA/Tesorería (enviando invitación automática de activación al segundo firmante).
3. **Paso 3 — Activación Inmediata con `1.000 € Exentos`:**
   - Acceso inmediato a `/school/[orgSlug]` para abrir el Buzón de Ideas o preparar borradores en el Estudio, completando la subida de los 4 documentos **KYB Paycomet** (CIF, Estatutos/Acta, DNI y Certificado IBAN) justo antes de publicar su primera campaña bancaria en `Recaudando`.

