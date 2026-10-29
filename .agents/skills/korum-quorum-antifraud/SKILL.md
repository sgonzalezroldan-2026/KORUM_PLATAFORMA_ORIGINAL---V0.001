---
name: korum-quorum-antifraud
description: Protocolos de Quórum, Anti-Fraude en Servidor, Doble Firma Mancomunada y Cumplimiento Legal/Fiscal (CNMV, Ley 49/2002, Modelo 182 AEAT y RGPD) de KORUM. Cargar siempre que se programen el Buzón de Ideas, el Doble Check, el candado semántico 0% o el área fiscal de Mi Hucha.
---

# Skill · Gobernanza de Quórum, Anti-Fraude en Servidor y Marco Legal/Fiscal

## 1. Participación Dual: Donación en 10s vs. Firma Registrada y Normalizada
1. **Aportaciones Económicas (`💛 Aportar Ahora`):**
   - **Sin registro obligatorio** (solo email ligero de entrega en modo invitado).
2. **Firmas en el Buzón de Ideas (`✍️ Firmar Apoyo`):**
   - **Requieren usuario autenticado con email verificado por Magic Link / OTP (`emailVerified !== null`).**
   - **Normalización Canónica Anti-Multicuenta:** Antes de validar unicidad, el servidor normaliza el email (`canonicalEmail`): convierte a minúsculas, elimina sub-alias `+` (`nombre+2@gmail.com` → `nombre@gmail.com`), ignora puntos en dominios Gmail/Googlemail y rechaza dominios de correo temporal/desechable.
   - **Límite estricto:** `1 única firma por canonicalEmail` en cada idea (`@@unique([ideaId, canonicalEmail])`).

---

## 2. Algoritmo Anti-Fraude Doméstico: Regla Padre y Madre (`<= 2` Cuentas/Dispositivo)

Combina cookie firmada `HttpOnly` de dispositivo + huella de navegador + control de ráfagas por subred IP (`/24`) para permitir que **madre y padre** firmen desde el mismo móvil, tablet u ordenador familiar sin falsos bloqueos, marcando como sospechosa cualquier 3ª cuenta o ráfaga automatizada:

```typescript
export interface SignatureAuditResult {
  status: 'VERIFIED' | 'SUSPICIOUS';
  reason: string;
  deviceAccountOrder: number;
}

export function normalizeCanonicalEmail(rawEmail: string): string {
  const [localRaw, domainRaw] = rawEmail.trim().toLowerCase().split('@');
  if (!localRaw || !domainRaw) return rawEmail.trim().toLowerCase();
  const baseLocal = localRaw.split('+')[0];
  if (domainRaw === 'gmail.com' || domainRaw === 'googlemail.com') {
    return `${baseLocal.replace(/\./g, '')}@gmail.com`;
  }
  return `${baseLocal}@${domainRaw}`;
}

export function evaluateIdeaSignatureFraud(params: {
  canonicalEmail: string;
  deviceCanonicalEmails: string[];
  ipBurstSignaturesLast10Min: number;
}): SignatureAuditResult {
  const updatedList = params.deviceCanonicalEmails.includes(params.canonicalEmail)
    ? params.deviceCanonicalEmails
    : [...params.deviceCanonicalEmails, params.canonicalEmail];

  const accountOrderOnDevice = updatedList.indexOf(params.canonicalEmail) + 1;

  if (params.ipBurstSignaturesLast10Min >= 6) {
    return {
      status: 'SUSPICIOUS',
      reason: '⚠️ Patrón de ráfaga anómalo detectado desde la misma red en menos de 10 minutos.',
      deviceAccountOrder: accountOrderOnDevice
    };
  }

  if (accountOrderOnDevice === 1) {
    return {
      status: 'VERIFIED',
      reason: '1ª cuenta familiar en el dispositivo (Verificada).',
      deviceAccountOrder: 1
    };
  }

  if (accountOrderOnDevice === 2) {
    return {
      status: 'VERIFIED',
      reason: '2ª cuenta familiar en el mismo dispositivo (Padre/Madre · Permitida y Verificada).',
      deviceAccountOrder: 2
    };
  }

  return {
    status: 'SUSPICIOUS',
    reason: `⚠️ ${accountOrderOnDevice}ª cuenta firmando desde el mismo dispositivo (Supera el máximo permitido de 2 cuentas familiares padre/madre).`,
    deviceAccountOrder: accountOrderOnDevice
  };
}
```

---

## 3. Doble Check Mancomunado Criptográfico Real (`ROLE_DIRECTOR` + `ROLE_AFA_PRESIDENT`)
- En producción, el **Doble Check** no es un clic unilateral: exige **2 registros independientes en `DoubleCheckSignature`** (uno firmado por el usuario con rol `DIRECTOR` y otro por el usuario con rol `AFA_PRESIDENT`), tanto para:
  1. Pasar una idea con quórum (`DOUBLE_CHECK`) a fase de `Presupuestación`.
  2. Liberar los fondos Escrow (`ESCROW_PAYOUT`) hacia el proveedor o cuenta del centro.
- Cuando firma el primero (`1/2`), el sistema envía enlace directo firmado + código OTP al segundo responsable para completar el candado mancomunado en 1 clic desde su móvil.

---

## 4. Candado Semántico Anti-Pillería con Límites de Palabra (`\b`) Sin Falsos Positivos
Cuando un centro elige una categoría `EXEMPT` (`0%` comisión, distinta de `Taquilla y Rifas`):
- **Prohibido usar `.includes('obra')` plano** (que bloqueaba erróneamente palabras como *"c**obra**r"*, *"s**obra**s"*, *"mani**obra**"* o *"obra de teatro"*).
- El motor normaliza acentos, elimina primero locuciones culturales/pedagógicas seguras (`obra de teatro`, `obra teatral`, `obra literaria`, `taller de pintura`, `pintura infantil`, `mano de obra solidaria`) y evalúa **expresiones regulares con límites de palabra estrictos (`\b`)** sobre infraestructura, climatización y hardware (`\b(ventilador|ventiladores|aire acondicionado|aerotermia|split|splits|climatizacion|climatizar|pizarra|pizarras|proyector|proyectores|reforma|reformas|fachada|asfaltado|cesped artificial|cancha|canchas|toldo|toldos|pergola|calefaccion|ordenador|ordenadores|portatil|portatiles|tablet|tablets|marcador led|obra|obras)\b`).
- Además, al liquidar a proveedor en `Logros y liquidaciones`, queda registrada la factura PDF adjunta para trazabilidad total.

---

## 5. Rigor Legal y Fiscal Automatizado (CNMV, AEAT Ley 49/2002, Modelo 182 y RGPD)
1. **Exención CNMV (Ley 5/2015):** Mecenazgo no financiero y taquilla con custodia en entidad de pago regulada PSD2 (Paycomet).
2. **Separación Estricta de Conceptos Fiscales y Condicional `ley49`:**
   - Ni las recargas de *Mi Hucha* (`TOPUP`) ni la compra de entradas/rifas (`TICKET`) se incluyen jamás en certificados de donación; solo las **aportaciones puras irrevocables (`DONATION`)** de campañas no reembolsadas.
   - Si `organization.ley49 === true` (Fundaciones y Asociaciones de Utilidad Pública), se emite **Certificado Fiscal IRPF (Ley 49/2002)** y el Panel del Centro habilita en enero la descarga en 1 clic del **fichero oficial AEAT Modelo 182 (`.BOE` / `.TXT`)**.
   - Si `organization.ley49 === false` (AMPAs o clubes ordinarios), tanto el checkout como *Mi Hucha* emiten exclusivamente un **Justificante Oficial Nominativo de Aportación**, evitando contingencias tributarias a las familias ante la AEAT.
3. **Derecho al Olvido RGPD:** Anonimiza PII (`email`, `fullName`, `nif`, `ip`) conservando únicamente los asientos contables anonimizados exigidos por la Ley General Tributaria (4 a 10 años).

