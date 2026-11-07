---
name: korum-quorum-antifraud
description: Quórum del buzón de ideas, antifraude en servidor (email canónico y regla padre/madre de máximo 2 cuentas por dispositivo, con privacidad desde el diseño), doble firma mancomunada DIRECTOR + COSIGNER, candado semántico con límites de palabra, fiscalidad (Ley 49/2002, Modelo 182) y derechos RGPD. Cargar siempre que se programen el buzón de ideas, la doble firma, el candado de categorías exentas o el área fiscal y de privacidad.
---

<!-- GENERADO AUTOMÁTICAMENTE desde .agents/skills/korum-quorum-antifraud/SKILL.md por scripts/sync-ai-context.mjs. No editar aquí: edita la fuente y vuelve a ejecutar el script. -->

# Skill · Quórum, antifraude, doble firma y marco fiscal y de privacidad

## 1. Dos formas de participar

1. **Aportar dinero (`💛 Aportar ahora`):** sin registro; en modo invitado solo se pide el email.
2. **Firmar una idea (`✍️ Firmar apoyo`):**
   - Requiere sesión con **email verificado** por enlace mágico u OTP (`user.emailVerified === true`).
   - **Email canónico:** antes de comprobar la unicidad, el servidor normaliza el email: minúsculas, sin sub-alias `+` (`nombre+2@gmail.com` → `nombre@gmail.com`), sin puntos en Gmail/Googlemail, y rechazo de dominios de correo desechable (lista mantenida en `src/core/security/disposable-domains.ts`).
   - **Una firma por email canónico e idea** (`@@unique([ideaId, canonicalEmail])`).

## 2. Regla padre y madre (máximo 2 cuentas por dispositivo)

Permite que madre y padre firmen desde el mismo móvil u ordenador familiar y marca como sospechosa la 3ª cuenta o las ráfagas automatizadas.

**Señales, de menos a más invasiva (privacidad desde el diseño):**

1. **Cookie propia de dispositivo** (`HttpOnly`, `Secure`, `SameSite=Lax`, firmada, 13 meses). Se crea solo cuando la persona firma una idea, porque es necesaria para el servicio que ha pedido (votación segura). En base de datos se guarda solo su hash (`Device.cookieIdHash`).
2. **Subred IP** (`/24` en IPv4, `/48` en IPv6), guardada solo como HMAC (`ipSubnetHash`) y únicamente para detectar ráfagas.
3. **Huella de navegador:** solo con **consentimiento** expreso (`ConsentPurpose.DEVICE_FINGERPRINT`) y siempre como HMAC (`Device.fingerprintHmac`). Sin consentimiento el sistema funciona igual con las señales 1 y 2.

La validez legal de este diseño (LSSI art. 22.2 y RGPD) está en la lista de comprobación del abogado ([docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](../../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §5).

```typescript
export interface SignatureAuditResult {
  status: 'VERIFIED' | 'SUSPICIOUS';
  /** Clave de traducción del motivo (los textos viven en messages/{es,ca,en}.json). */
  reasonKey: 'ideas.audit.ipBurst' | 'ideas.audit.firstAccount' | 'ideas.audit.secondAccount' | 'ideas.audit.tooManyAccounts';
  deviceAccountOrder: number;
}

export function evaluateIdeaSignatureFraud(params: {
  deviceAccountOrder: number;
  ipBurstSignaturesLast10Min: number;
}): SignatureAuditResult {
  const { deviceAccountOrder } = params;
  if (params.ipBurstSignaturesLast10Min >= 6) return { status: 'SUSPICIOUS', reasonKey: 'ideas.audit.ipBurst', deviceAccountOrder };
  if (deviceAccountOrder > 2) return { status: 'SUSPICIOUS', reasonKey: 'ideas.audit.tooManyAccounts', deviceAccountOrder };
  return { status: 'VERIFIED', reasonKey: deviceAccountOrder === 1 ? 'ideas.audit.firstAccount' : 'ideas.audit.secondAccount', deviceAccountOrder };
}
```

El email canónico está en `src/core/security/email-normalizer.ts` y el orden lo calcula `signIdea` (`device-quorum.service.ts`):

- **Una firma por persona e idea:** se comprueba por email canónico y por `userId`; cambiar de email no da otra firma.
- **La cuenta se identifica por `userId`** y su orden se fija al llegar al dispositivo. Con consentimiento e IP válida, cuentan juntos los dispositivos con la **misma huella y la misma red en los últimos 30 días**: solo la huella no basta, porque dos móviles iguales de dos familias pueden darla idéntica.
- **Ráfaga:** firmas previas de la misma subred, por idea, en 10 minutos. Sin una IP válida se usa el grupo común `unknown-ip`, que también cuenta.
- **Retirar el consentimiento** borra la huella de todos los dispositivos de esa persona y devuelve su orden al de llegada en cada uno (`clearFingerprintsOf`).

Textos de referencia en castellano para esas claves: `⚠️ Muchas firmas desde la misma red en menos de 10 minutos.` · `1ª cuenta familiar en este dispositivo (verificada).` · `2ª cuenta familiar en el mismo dispositivo (padre/madre, verificada).` · `⚠️ {n}ª cuenta firmando desde el mismo dispositivo (máximo 2 por familia).`

- **Interfaz y petición (Sprint 3.6):** `signIdeaForRequest` y `proposeIdeaForRequest` (`src/services/ideas/idea-requests.service.ts`) las llama la Server Action del buzón, que entrega la IP de `trustedClientIp` y la cookie `korum_device`; sin IP válida se abre la alerta `TRUSTED_IP_MISSING`. La firma y la supresión usan el **mismo** `DATA_HMAC_SECRET`. El alias de una idea es siempre `#FAM-NNNN` y lo genera el servidor (`generateIdeaAlias`). La huella solo se calcula y envía tras el consentimiento y se retira con un clic en el propio buzón.

## 3. Doble firma mancomunada (`DIRECTOR` + `COSIGNER`)

- La doble firma exige **dos registros en `DoubleCheckSignature` de dos personas distintas**, una con rol `DIRECTOR` y otra con rol `COSIGNER`, para:
  1. Pasar una idea con quórum (`DOUBLE_CHECK`) a `BUDGETING`.
  2. Liberar fondos (`ESCROW_PAYOUT`) hacia la entidad o su proveedor.
- Cada firma guarda `signatureHash`, HMAC de la entidad, el tipo y el id del objetivo, lo firmado (`targetDigest`: importe, cuenta destino e IBAN de una liquidación; texto de una idea), el firmante, su rol, la fila de su cargo (`membershipId`), la fecha y `otpVerifiedAt`. Si cambia lo firmado, o quien firmó pierde el cargo, la firma deja de valer, aunque luego se le devuelva: un trigger impide editar el rol de una fila de `OrganizationMember`, así que recuperarlo crea una fila nueva. Al volver a firmar ese rol, la firma antigua se sustituye y se copia entera a `AuditLog` (`double_check.signature_superseded`), con lo necesario para verificar su huella.
- **Toda firma exige enlace + OTP + la sesión de esa misma persona**, con 2FA activado. El Super-Admin y las cuentas anonimizadas nunca firman. Dos cuentas con la misma bandeja de entrada canónica cuentan como una sola persona (`SAME_INBOX`). `completeSignature` no aprueba una liquidación: quien llama ejecuta `approvePayout`, que lo vuelve a comprobar todo en la transacción que mueve el dinero. Los intentos denegados quedan en `AuditLog` (`double_check.denied`).
- Tras la 1ª firma (`1/2`), la otra persona recibe un enlace firmado de un solo uso (caduca en 72 h) + OTP de 6 dígitos para firmar en 1 clic desde el móvil.
- **Etiqueta visible del cargo** (`OrganizationMember.roleLabel`), según la entidad: *Dirección del centro*, *Presidencia del AMPA/AFA*, *Presidencia/Tesorería del club*, *Representación del patronato*, *Titularidad del colegio*. Una misma persona nunca ocupa los dos roles en la misma entidad.

## 4. Candado semántico de categorías exentas (`\b`, sin falsos positivos)

Cuando una entidad elige una categoría `EXEMPT` (`0 %`, distinta de *Taquilla y rifas*):

- **Prohibido `.includes('obra')`** (bloqueaba *"c**obra**r"*, *"s**obra**s"*, *"mani**obra**"* u *"obra de teatro"*).
- Se normalizan acentos, se eliminan primero las expresiones culturales seguras (`obra de teatro`, `obra social`, `obra solidaria`, `taller de pintura`, `mano de obra solidaria`…) y se buscan palabras completas sobre infraestructura y equipamiento, en **castellano, catalán e inglés**. Las listas viven en `src/core/security/semantic-lock.ts`, que es lo que manda.
- **La lista blanca solo admite expresiones cerradas**, que no puedan continuar con un aparato o una instalación: `fans de` dejaría pasar «fans de techo», y `reforma educativa` dejaría pasar «reforma educativa del gimnasio». Ante la duda se bloquea, porque el candado solo pide elegir una categoría con tramos.

## 5. Fiscalidad (Ley 49/2002 y Modelo 182)

1. **Separación de conceptos:** recargas (`TOPUP`) y entradas o rifas (`TICKET`) nunca aparecen en certificados; solo las **donaciones (`DONATION`) completadas y no reembolsadas**.
2. **Certificado fiscal y Modelo 182** solo si `organization.ley49 === true` **y** `ley49VerifiedAt` no es nulo (fundaciones y asociaciones declaradas de utilidad pública que lo hayan acreditado). El panel de la entidad ofrece en enero la descarga del fichero del **Modelo 182** (registro de declarante y registros de declarados, en formato de longitud fija de la AEAT), con el NIF, nombre, provincia, importe y marca de recurrencia de cada donante (calculada por `donorTaxIdHmac` sobre los dos ejercicios anteriores).
3. **Resto de entidades** (la mayoría de AMPAs y clubes): se emite un **justificante nominativo de aportación**, sin efectos fiscales.
4. **Validación de NIF/NIE/CIF** con el algoritmo oficial (módulo 23 para DNI/NIE y dígito de control para CIF).
5. **Ojo:** las cantidades aportadas a un **colegio privado con ánimo de lucro** pueden no ser donaciones a efectos fiscales; el alta de una entidad `SCHOOL_OWNER` no puede marcar `ley49` y su tratamiento lo confirma la asesoría (ver la lista del abogado).

## 6. Derechos RGPD

- **Acceso y portabilidad:** exportación en JSON y PDF de los datos de la persona desde *Mi cuenta* (`PrivacyRequest` `EXPORT`), en menos de un mes.
- **Supresión (derecho al olvido):** se anonimizan nombre, email, NIF, tokens e identificadores de dispositivo (`gdprAnonymizedAt`) y se **conservan** los asientos y documentos fiscales el tiempo que exige la ley (Ley General Tributaria y normativa contable), sin datos que identifiquen a la persona más allá de lo obligatorio.
- **Oposición y consentimientos:** cada consentimiento (`ConsentRecord`) se puede retirar desde *Mi cuenta* con el mismo esfuerzo con el que se dio.
- Plazos de conservación: tabla en [docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md](../../../docs/CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md) §6, aplicados por la tarea `DATA_RETENTION_PURGE`.
- **Dónde está (Sprint 2.5):** `src/core/privacy/` — `consents.ts` (`recordConsent`: retirar la huella llama a `clearFingerprintsOf` al momento), `privacy-requests.ts` (plazo de un mes, email solo como HMAC), `personal-data-export.ts` + `export-pdf.ts` (JSON y PDF con los textos de `privacy.export.*`), `erasure.service.ts` (`erasePersonalData`) y `retention-*.ts`. Al anonimizar **no se borran filas `DeviceAccount`** (el orden de las demás cuentas se calcula con ellas): se sustituye su email canónico por una marca `anonimizado:*`, igual que en `IdeaSignatureAudit` e `Idea.authorCanonicalEmail`.
