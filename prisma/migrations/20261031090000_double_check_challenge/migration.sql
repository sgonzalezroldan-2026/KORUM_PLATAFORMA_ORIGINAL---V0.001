-- Enlace de un solo uso + OTP de la doble firma: solo se guardan sus HMAC.
CREATE TABLE "DoubleCheckChallenge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetType" "DoubleCheckTargetType" NOT NULL,
    "ideaId" INTEGER,
    "payoutId" INTEGER,
    "signerUserId" TEXT NOT NULL,
    "signerRole" "MemberRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "otpHmac" TEXT NOT NULL,
    "targetDigest" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoubleCheckChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DoubleCheckChallenge_tokenHash_key" ON "DoubleCheckChallenge"("tokenHash");
CREATE INDEX "DoubleCheckChallenge_targetType_ideaId_signerUserId_idx" ON "DoubleCheckChallenge"("targetType", "ideaId", "signerUserId");
CREATE INDEX "DoubleCheckChallenge_targetType_payoutId_signerUserId_idx" ON "DoubleCheckChallenge"("targetType", "payoutId", "signerUserId");

ALTER TABLE "DoubleCheckChallenge" ADD CONSTRAINT "DoubleCheckChallenge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DoubleCheckChallenge" ADD CONSTRAINT "DoubleCheckChallenge_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DoubleCheckChallenge" ADD CONSTRAINT "DoubleCheckChallenge_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "EscrowPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DoubleCheckChallenge" ADD CONSTRAINT "DoubleCheckChallenge_signerUserId_fkey" FOREIGN KEY ("signerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
