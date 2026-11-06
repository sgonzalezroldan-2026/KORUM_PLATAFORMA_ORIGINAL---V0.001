-- Sprint 3.5 · Patrocinio de comercios: el cobro del patrocinio se enlaza con su comercio.
ALTER TABLE "Contribution" ADD COLUMN "sponsorId" INTEGER;

CREATE UNIQUE INDEX "Contribution_sponsorId_key" ON "Contribution"("sponsorId");

ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
