-- Sprint 4.2a · Moderación de ideas y doble firma. Una idea que completa su doble firma (`CONVERTED`) crea su iniciativa en `BUDGETING` en la
-- misma transacción (PRD §4.2). `sourceIdeaId` es único: una idea nunca crea dos iniciativas, aunque la conversión se repita.
ALTER TABLE "Initiative" ADD COLUMN "sourceIdeaId" INTEGER;

CREATE UNIQUE INDEX "Initiative_sourceIdeaId_key" ON "Initiative"("sourceIdeaId");

ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_sourceIdeaId_fkey" FOREIGN KEY ("sourceIdeaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Recupera las ideas que ya estaban en `CONVERTED` sin iniciativa (heredado del Sprint 2.2): la crea en presupuestación con meta 0 y cierre
-- provisional (hoy + duración máxima de campaña), que el Estudio (Sprint 4.3) completa antes de publicar. Curso y trimestre se calculan como
-- `academicYearFor` (el curso empieza el 22 de agosto, UTC). La hucha `WLT-ESC-XXXXXX` usa el mismo alfabeto sin caracteres ambiguos.
WITH pending AS (
  SELECT i."id", i."organizationId", i."title", i."category", i."description",
         now() AT TIME ZONE 'UTC' AS today,
         (now() AT TIME ZONE 'UTC') + make_interval(days => COALESCE((SELECT g."maxCampaignDays" FROM "GlobalConfig" g WHERE g."id" = 'GLOBAL'), 60)) AS closes
  FROM "Idea" i
  WHERE i."phase" = 'CONVERTED' AND NOT EXISTS (SELECT 1 FROM "Initiative" n WHERE n."sourceIdeaId" = i."id")
)
INSERT INTO "Initiative" ("walletEscrowId", "format", "organizationId", "academicYear", "title", "category", "stage", "status", "stepIndex", "closesAt", "quarter", "goalCents", "description", "sourceIdeaId", "createdAt", "updatedAt")
SELECT
  'WLT-ESC-' || (
    SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
    FROM generate_series(1, 6) AS position
    WHERE position > 0 AND p."id" IS NOT NULL
  ),
  'BUDGET',
  p."organizationId",
  CASE
    WHEN EXTRACT(MONTH FROM p.today) > 8 OR (EXTRACT(MONTH FROM p.today) = 8 AND EXTRACT(DAY FROM p.today) >= 22)
      THEN EXTRACT(YEAR FROM p.today)::int || '-' || (EXTRACT(YEAR FROM p.today)::int + 1)
    ELSE (EXTRACT(YEAR FROM p.today)::int - 1) || '-' || EXTRACT(YEAR FROM p.today)::int
  END,
  p."title",
  p."category",
  '',
  'BUDGETING',
  3,
  p.closes,
  EXTRACT(YEAR FROM p.closes)::int || '-Q' || EXTRACT(QUARTER FROM p.closes)::int,
  0,
  p."description",
  p."id",
  now(),
  now()
FROM pending p;
