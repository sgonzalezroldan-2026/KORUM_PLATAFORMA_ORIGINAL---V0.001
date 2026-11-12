-- Sprint 5.2 (cuarta ronda): el relevo de firmantes ya no pide el visto bueno de quien sale (decisión del promotor, 2026-11-12).
-- La restricción obligaba a rellenar `consentedAt` en todo relevo invitado, así que el servicio escribía la fecha de la propuesta como si fuera un
-- consentimiento. Se quita: `consentedAt` queda solo en los relevos antiguos (los de antes de esta decisión) y los nuevos lo llevan vacío.
ALTER TABLE "SignerHandover" DROP CONSTRAINT IF EXISTS "SignerHandover_consent_check";
