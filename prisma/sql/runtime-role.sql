-- =============================================================================
-- KORUM · Rol de ejecución de la aplicación (se aplica en la preproducción, Sprint 6.1)
--
-- Por qué: el PROPIETARIO de las tablas puede saltarse la inmutabilidad del libro mayor
-- (`ALTER TABLE ... DISABLE TRIGGER`, `SET session_replication_role = replica`). Por eso la aplicación
-- no se conecta como propietaria, sino con `korum_app`, que no puede desactivar triggers, no es
-- superusuario y no tiene UPDATE, DELETE ni TRUNCATE sobre el libro mayor y la auditoría.
--
-- Uso (como propietario, con la conexión directa de las migraciones):
--   psql "$DIRECT_URL" -v app_password="contraseña-larga-y-aleatoria" -f prisma/sql/runtime-role.sql
-- Después:
--   DATABASE_URL  → usuario korum_app (lo usa la aplicación)
--   DIRECT_URL    → propietario (solo para `prisma migrate deploy`)
-- Volver a ejecutarlo tras cada migración que cree tablas append-only nuevas.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'korum_app') THEN
    CREATE ROLE korum_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE korum_app WITH PASSWORD :'app_password';

GRANT USAGE ON SCHEMA public TO korum_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO korum_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO korum_app;

-- Libro mayor y auditoría: solo lectura y altas.
REVOKE UPDATE, DELETE, TRUNCATE ON "LedgerJournal", "EscrowLedgerEntry", "AuditLog" FROM korum_app;

-- Excepción de privacidad: la tarea de retención puede anonimizar la IP (HMAC) y el navegador de la auditoría. El trigger
-- `AuditLog_immutable` solo deja pasar ese UPDATE (ambas columnas a NULL y nada más cambiado).
GRANT UPDATE ("ipHash", "userAgent") ON "AuditLog" TO korum_app;

-- La tabla de control de migraciones no es de la aplicación.
REVOKE ALL ON "_prisma_migrations" FROM korum_app;

-- Tablas y secuencias que creen las migraciones futuras.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO korum_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO korum_app;
