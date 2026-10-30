-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('es', 'ca', 'en');

-- CreateEnum
CREATE TYPE "OrganizationVertical" AS ENUM ('SCHOOL', 'SPORTS_CLUB', 'CULTURAL');

-- CreateEnum
CREATE TYPE "LegalForm" AS ENUM ('PARENTS_ASSOCIATION', 'SCHOOL_OWNER', 'FOUNDATION', 'SPORTS_ENTITY', 'CULTURAL_ASSOCIATION', 'OTHER_NONPROFIT');

-- CreateEnum
CREATE TYPE "CenterOwnership" AS ENUM ('PUBLIC', 'CONCERTED', 'PRIVATE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "KybStatus" AS ENUM ('PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('OK', 'CALL');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('FAMILY', 'MERCHANT', 'DIRECTOR', 'COSIGNER', 'GATEKEEPER');

-- CreateEnum
CREATE TYPE "InitiativeFormat" AS ENUM ('BUDGET', 'TICKETING');

-- CreateEnum
CREATE TYPE "InitiativeStatus" AS ENUM ('BUDGETING', 'FUNDRAISING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TicketSubtype" AS ENUM ('EVENT', 'RAFFLE');

-- CreateEnum
CREATE TYPE "TicketFeeMode" AS ENUM ('ADD', 'INC');

-- CreateEnum
CREATE TYPE "CategoryRuleType" AS ENUM ('EXEMPT', 'BRACKETS');

-- CreateEnum
CREATE TYPE "BracketMode" AS ENUM ('FLAT', 'MARGINAL');

-- CreateEnum
CREATE TYPE "SponsorCategoryLevel" AS ENUM ('ORO', 'PLATA', 'BRONCE');

-- CreateEnum
CREATE TYPE "SponsorStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CREDIT_POOL', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SponsorRenewalRule" AS ENUM ('SOONEST', 'PROPORTIONAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "SignatureStatus" AS ENUM ('VERIFIED', 'SUSPICIOUS');

-- CreateEnum
CREATE TYPE "IdeaPhase" AS ENUM ('PHASE0_MOD', 'PUBLIC_VOTING', 'DOUBLE_CHECK', 'CONVERTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "IdeaMessageSender" AS ENUM ('FAMILY', 'ORGANIZATION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DoubleCheckTargetType" AS ENUM ('IDEA_APPROVAL', 'ESCROW_PAYOUT');

-- CreateEnum
CREATE TYPE "ContributionType" AS ENUM ('DONATION', 'TICKET', 'SPONSORSHIP', 'SELF_BOOST', 'MATCHING_FUND');

-- CreateEnum
CREATE TYPE "ContributionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUND_PENDING', 'REFUNDED', 'CHARGEBACK');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'BIZUM', 'APPLE_PAY', 'GOOGLE_PAY', 'HUCHA', 'PLATFORM');

-- CreateEnum
CREATE TYPE "WalletTxType" AS ENUM ('INSTANT_TOPUP', 'MONTHLY_TOPUP', 'CONTRIBUTION_DEBIT', 'REFUND_TO_ORIGIN');

-- CreateEnum
CREATE TYPE "WalletTxStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PayoutDestination" AS ENUM ('PROVIDER', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING_DOUBLE_CHECK', 'APPROVED', 'PROCESSING', 'EXECUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ResizePollStatus" AS ENUM ('OPEN', 'CLOSED_APPROVED', 'CLOSED_REJECTED');

-- CreateEnum
CREATE TYPE "SupportTarget" AS ENUM ('ORGANIZATION', 'SUPERADMIN');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

-- CreateEnum
CREATE TYPE "InvoiceVerifactuStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'ACCEPTED_WITH_ERRORS', 'REJECTED');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('PSP_CLEARING', 'INITIATIVE_ESCROW', 'FAMILY_WALLET', 'SPONSOR_CREDIT_POOL', 'MATCHING_POOL', 'ORG_PAYABLE', 'REFUNDS_PAYABLE', 'TAX_PAYABLE_VAT', 'KORUM_REVENUE_GUARANTEE', 'KORUM_REVENUE_BRACKET', 'KORUM_REVENUE_SPONSOR_FEE', 'KORUM_REVENUE_TICKET_FEE', 'KORUM_REVENUE_MAINTENANCE', 'KORUM_REVENUE_TOPUP_FEE', 'GATEWAY_FEES_RECOVERED', 'GATEWAY_FEES_EXPENSE', 'AUTO_BOOST_EXPENSE', 'CHARGEBACK_LOSSES');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerJournalKind" AS ENUM ('PAYIN_DONATION', 'PAYIN_TICKET', 'PAYIN_SPONSOR', 'PAYIN_HUCHA_TOPUP', 'HUCHA_SPEND', 'HUCHA_REFUND_ORIGIN', 'GATEWAY_FEE', 'SELF_BOOST_INJECTION', 'MATCHING_RELEASE', 'PAYOUT_APPROVAL', 'SPLIT_PAYOUT_ORGANIZATION', 'SPLIT_PAYOUT_PROVIDER', 'ESCROW_REFUND_DONOR', 'CREDIT_POOL_TRANSFER', 'CHARGEBACK', 'INVOICE_VAT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'WEBHOOK', 'GATE_SESSION');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('CAMPAIGN_EXPIRY', 'MASS_REFUND', 'MONTHLY_TOPUP', 'SPONSOR_RENEWAL_NOTICE', 'SPONSOR_RENEWAL_CHARGE', 'CREDIT_POOL_EXPIRY', 'SPLIT_WINDOW_GUARD', 'PSP_RECONCILIATION', 'MODEL182_REMINDER', 'DATA_RETENTION_PURGE', 'OUTBOX_DISPATCH');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FileVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "FilePurpose" AS ENUM ('ORG_LOGO', 'ORG_BANNER', 'INITIATIVE_COVER', 'INITIATIVE_BEFORE', 'INITIATIVE_AFTER', 'KYB_DOCUMENT', 'PROVIDER_INVOICE', 'KORUM_INVOICE_PDF', 'SPONSOR_LOGO', 'TAX_CERTIFICATE', 'MODEL182_EXPORT');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('ANALYTICS_COOKIES', 'DEVICE_FINGERPRINT', 'MARKETING_EMAILS', 'PUBLIC_SUPPORTER_NAME');

-- CreateEnum
CREATE TYPE "PrivacyRequestType" AS ENUM ('ACCESS', 'EXPORT', 'RECTIFICATION', 'ERASURE', 'OBJECTION');

-- CreateEnum
CREATE TYPE "PrivacyRequestStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "GlobalConfig" (
    "id" TEXT NOT NULL DEFAULT 'GLOBAL',
    "exemptLimitCents" INTEGER NOT NULL DEFAULT 100000,
    "bracketMode" "BracketMode" NOT NULL DEFAULT 'FLAT',
    "t1MaxCents" INTEGER NOT NULL DEFAULT 500000,
    "t2MaxCents" INTEGER NOT NULL DEFAULT 1500000,
    "t1Bps" INTEGER NOT NULL DEFAULT 500,
    "t2Bps" INTEGER NOT NULL DEFAULT 400,
    "t3Bps" INTEGER NOT NULL DEFAULT 300,
    "sponsorFeeBps" INTEGER NOT NULL DEFAULT 1500,
    "fullIntegrityCheckCents" INTEGER NOT NULL DEFAULT 180,
    "guaranteePresetsCents" INTEGER[] DEFAULT ARRAY[0, 100, 200, 400]::INTEGER[],
    "defaultGuaranteeIdx" INTEGER NOT NULL DEFAULT 2,
    "gatewayPctBps" INTEGER NOT NULL DEFAULT 100,
    "gatewayFixedCents" INTEGER NOT NULL DEFAULT 9,
    "topupFeeCents" INTEGER NOT NULL DEFAULT 25,
    "topupFeeBps" INTEGER NOT NULL DEFAULT 0,
    "ticketFeeFixedCents" INTEGER NOT NULL DEFAULT 45,
    "ticketFeeBps" INTEGER NOT NULL DEFAULT 200,
    "maintActive" BOOLEAN NOT NULL DEFAULT false,
    "maintPerInitCents" INTEGER NOT NULL DEFAULT 4900,
    "maintAnnualCapCents" INTEGER NOT NULL DEFAULT 14700,
    "maxCampaignDays" INTEGER NOT NULL DEFAULT 60,
    "creditPoolMaxDays" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedalTierConfig" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "campaignsRequired" INTEGER NOT NULL,
    "grantCents" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedalTierConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "GlobalCategory" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '✨',
    "rule" "CategoryRuleType" NOT NULL DEFAULT 'BRACKETS',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PlatformSecret" (
    "key" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "hint" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSecret_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "canonicalEmail" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "image" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isSuperadmin" BOOLEAN NOT NULL DEFAULT false,
    "locale" "Locale" NOT NULL DEFAULT 'es',
    "nifEnc" TEXT,
    "nifHmac" TEXT,
    "nifKeyVersion" INTEGER,
    "provinceCode" TEXT,
    "postalCode" TEXT,
    "walletBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "walletProvider" TEXT,
    "walletExternalId" TEXT,
    "activeOrganizationId" TEXT,
    "gdprAnonymizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TwoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Passkey" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "publicKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialID" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "transports" TEXT,
    "aaguid" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "legalForm" "LegalForm" NOT NULL,
    "centerOwnership" "CenterOwnership" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "vertical" "OrganizationVertical" NOT NULL DEFAULT 'SCHOOL',
    "province" TEXT NOT NULL,
    "provinceCode" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "cif" TEXT,
    "iban" TEXT,
    "walletId" TEXT NOT NULL,
    "paycometSplitId" TEXT,
    "kybStatus" "KybStatus" NOT NULL DEFAULT 'PENDING',
    "kybReviewedAt" TIMESTAMP(3),
    "kybReviewedById" TEXT,
    "health" "HealthStatus" NOT NULL DEFAULT 'OK',
    "completedThisYear" INTEGER NOT NULL DEFAULT 0,
    "completedHistorical" INTEGER NOT NULL DEFAULT 0,
    "activeSponsorsCount" INTEGER NOT NULL DEFAULT 0,
    "historicalSponsorsCount" INTEGER NOT NULL DEFAULT 0,
    "medalRank" INTEGER NOT NULL DEFAULT 0,
    "ley49" BOOLEAN NOT NULL DEFAULT false,
    "ley49VerifiedAt" TIMESTAMP(3),
    "customRules" BOOLEAN NOT NULL DEFAULT false,
    "exemptLimitCents" INTEGER NOT NULL DEFAULT 100000,
    "exemptRemainingCents" INTEGER NOT NULL DEFAULT 100000,
    "medalGrantAvailableCents" INTEGER NOT NULL DEFAULT 0,
    "medalGrantUsedInTitle" TEXT,
    "t1Bps" INTEGER NOT NULL DEFAULT 500,
    "t2Bps" INTEGER NOT NULL DEFAULT 400,
    "t3Bps" INTEGER NOT NULL DEFAULT 300,
    "sponsorFeeBps" INTEGER NOT NULL DEFAULT 1500,
    "fullIntegrityCheckCents" INTEGER NOT NULL DEFAULT 180,
    "ticketFeeFixedCents" INTEGER NOT NULL DEFAULT 45,
    "ticketFeeBps" INTEGER NOT NULL DEFAULT 200,
    "maintActive" BOOLEAN NOT NULL DEFAULT false,
    "maintPerInitCents" INTEGER NOT NULL DEFAULT 4900,
    "maintAnnualCapCents" INTEGER NOT NULL DEFAULT 14700,
    "maintPaidCents" INTEGER NOT NULL DEFAULT 0,
    "donationPresetsCents" INTEGER[] DEFAULT ARRAY[1000, 2500, 5000]::INTEGER[],
    "defaultDonationIdx" INTEGER NOT NULL DEFAULT 1,
    "sponsorTiersCents" INTEGER[] DEFAULT ARRAY[10000, 25000, 50000]::INTEGER[],
    "sponsorRenewalRule" "SponsorRenewalRule" NOT NULL DEFAULT 'SOONEST',
    "participationGroupsJson" JSONB,
    "minVotes" INTEGER NOT NULL DEFAULT 30,
    "maxIdeaDays" INTEGER NOT NULL DEFAULT 45,
    "brandPrimary" TEXT NOT NULL DEFAULT '#FF5A43',
    "brandSecondary" TEXT NOT NULL DEFAULT '#FFB800',
    "logoFileId" TEXT,
    "bannerFileId" TEXT,
    "contentLocale" "Locale" NOT NULL DEFAULT 'es',
    "publicIndexing" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "roleLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationCategory" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '🌟',
    "rule" "CategoryRuleType" NOT NULL DEFAULT 'BRACKETS',
    "isCustom" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "OrganizationCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Initiative" (
    "id" SERIAL NOT NULL,
    "walletEscrowId" TEXT NOT NULL,
    "paycometEscrowOrderId" TEXT,
    "format" "InitiativeFormat" NOT NULL DEFAULT 'BUDGET',
    "organizationId" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" "InitiativeStatus" NOT NULL DEFAULT 'BUDGETING',
    "stepIndex" INTEGER NOT NULL DEFAULT 3,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "firstPayinAt" TIMESTAMP(3),
    "quarter" TEXT NOT NULL,
    "raisedCents" INTEGER NOT NULL DEFAULT 0,
    "goalCents" INTEGER NOT NULL,
    "totalContributions" INTEGER NOT NULL DEFAULT 0,
    "costMatCents" INTEGER NOT NULL DEFAULT 0,
    "costInstCents" INTEGER NOT NULL DEFAULT 0,
    "contingencyBps" INTEGER NOT NULL DEFAULT 1000,
    "showPublicBreakdown" BOOLEAN NOT NULL DEFAULT true,
    "defaultExemptAppliedCents" INTEGER NOT NULL DEFAULT 0,
    "medalExemptAppliedCents" INTEGER NOT NULL DEFAULT 0,
    "quotaReservedAt" TIMESTAMP(3),
    "quotaReleasedAt" TIMESTAMP(3),
    "medalRankApplied" INTEGER NOT NULL DEFAULT 0,
    "bracketRateAppliedBps" INTEGER NOT NULL DEFAULT 0,
    "bracketFeeCents" INTEGER NOT NULL DEFAULT 0,
    "maintFeeCents" INTEGER NOT NULL DEFAULT 0,
    "gatewayFeeCents" INTEGER NOT NULL DEFAULT 0,
    "absorbsGatewayCostByKorum" BOOLEAN NOT NULL DEFAULT false,
    "matchingPoolTotalCents" INTEGER NOT NULL DEFAULT 0,
    "matchingPoolRemainingCents" INTEGER NOT NULL DEFAULT 0,
    "matchingSponsorName" TEXT,
    "ticketSubtype" "TicketSubtype",
    "ticketPriceCents" INTEGER,
    "ticketMax" INTEGER,
    "ticketsSold" INTEGER NOT NULL DEFAULT 0,
    "ticketFeeMode" "TicketFeeMode",
    "ticketVenue" TEXT,
    "gatePinHash" TEXT,
    "gatePinExpiresAt" TIMESTAMP(3),
    "plaqueEnabled" BOOLEAN NOT NULL DEFAULT true,
    "rewardEnabled" BOOLEAN NOT NULL DEFAULT true,
    "targetFamiliesPerCourse" INTEGER NOT NULL DEFAULT 35,
    "rewardText" TEXT,
    "description" TEXT NOT NULL,
    "thanksMessage" TEXT,
    "translationsJson" JSONB,
    "coverFileId" TEXT,
    "beforeFileId" TEXT,
    "afterFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Initiative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InitiativeCourseProgress" (
    "id" SERIAL NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "groupName" TEXT NOT NULL,
    "familiesCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InitiativeCourseProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sponsor" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "initiativeId" INTEGER,
    "name" TEXT NOT NULL,
    "cif" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "logoFileId" TEXT,
    "sector" TEXT NOT NULL,
    "categoryLevel" "SponsorCategoryLevel" NOT NULL DEFAULT 'PLATA',
    "tierRank" INTEGER NOT NULL DEFAULT 2,
    "tierLabel" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "feeGeneratedCents" INTEGER NOT NULL,
    "isMatchingPool" BOOLEAN NOT NULL DEFAULT false,
    "promo" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "paymentMethodTokenId" INTEGER,
    "paidAt" TIMESTAMP(3),
    "status" "SponsorStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Idea" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "authorCanonicalEmail" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "phase" "IdeaPhase" NOT NULL DEFAULT 'PHASE0_MOD',
    "votes" INTEGER NOT NULL DEFAULT 1,
    "verifiedVotes" INTEGER NOT NULL DEFAULT 1,
    "suspiciousVotes" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Idea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "cookieIdHash" TEXT NOT NULL,
    "fingerprintHmac" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceAccount" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canonicalEmail" TEXT NOT NULL,
    "accountOrder" INTEGER NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdeaSignatureAudit" (
    "id" SERIAL NOT NULL,
    "ideaId" INTEGER NOT NULL,
    "userId" TEXT,
    "canonicalEmail" TEXT NOT NULL,
    "deviceId" TEXT,
    "ipSubnetHash" TEXT,
    "accountOrder" INTEGER NOT NULL DEFAULT 1,
    "status" "SignatureStatus" NOT NULL DEFAULT 'VERIFIED',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdeaSignatureAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdeaMessage" (
    "id" SERIAL NOT NULL,
    "ideaId" INTEGER NOT NULL,
    "senderRole" "IdeaMessageSender" NOT NULL,
    "senderLabel" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdeaMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoubleCheckSignature" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetType" "DoubleCheckTargetType" NOT NULL,
    "ideaId" INTEGER,
    "payoutId" INTEGER,
    "signerUserId" TEXT NOT NULL,
    "signerRole" "MemberRole" NOT NULL,
    "signatureHash" TEXT NOT NULL,
    "otpVerifiedAt" TIMESTAMP(3),
    "signerIpHash" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoubleCheckSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contribution" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "userId" TEXT,
    "guestEmail" TEXT,
    "canonicalEmail" TEXT,
    "locale" "Locale" NOT NULL DEFAULT 'es',
    "fiscalYear" INTEGER NOT NULL,
    "type" "ContributionType" NOT NULL DEFAULT 'DONATION',
    "groupName" TEXT,
    "amountCents" INTEGER NOT NULL,
    "guaranteeContributionCents" INTEGER NOT NULL DEFAULT 0,
    "matchedBonusCents" INTEGER NOT NULL DEFAULT 0,
    "totalChargedCents" INTEGER NOT NULL,
    "isTaxDeductible" BOOLEAN NOT NULL DEFAULT false,
    "donorFullName" TEXT,
    "donorTaxIdEnc" TEXT,
    "donorTaxIdHmac" TEXT,
    "donorTaxIdKeyVersion" INTEGER,
    "donorProvinceCode" TEXT,
    "publiclyDisclosed" BOOLEAN NOT NULL DEFAULT true,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "paycometOrder" TEXT,
    "paycometAuthCode" TEXT,
    "status" "ContributionStatus" NOT NULL DEFAULT 'PENDING',
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketPass" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "contributionId" INTEGER NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "serialCode" TEXT NOT NULL,
    "subtype" "TicketSubtype" NOT NULL DEFAULT 'EVENT',
    "holderEmail" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "checkedInCount" INTEGER NOT NULL DEFAULT 0,
    "raffleNumbers" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "qrHmacSignature" TEXT NOT NULL,
    "lastCheckedInAt" TIMESTAMP(3),
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketPass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateSession" (
    "id" TEXT NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "GateSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketCheckIn" (
    "id" SERIAL NOT NULL,
    "ticketPassId" INTEGER NOT NULL,
    "gateSessionId" TEXT,
    "quantity" INTEGER NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerJournal" (
    "id" SERIAL NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" "LedgerJournalKind" NOT NULL,
    "organizationId" TEXT,
    "initiativeId" INTEGER,
    "contributionId" INTEGER,
    "walletTxId" INTEGER,
    "payoutId" INTEGER,
    "paycometReference" TEXT,
    "description" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "reversesJournalId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscrowLedgerEntry" (
    "id" SERIAL NOT NULL,
    "journalId" INTEGER NOT NULL,
    "account" "LedgerAccount" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "organizationId" TEXT,
    "initiativeId" INTEGER,
    "userId" TEXT,
    "sponsorId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethodToken" (
    "id" SERIAL NOT NULL,
    "userId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'paycomet',
    "idUserEnc" TEXT NOT NULL,
    "tokenUserEnc" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "expiresMonth" INTEGER,
    "expiresYear" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentMethodToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "contributionId" INTEGER,
    "paymentMethodTokenId" INTEGER,
    "txType" "WalletTxType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "remainingRefundableCents" INTEGER NOT NULL DEFAULT 0,
    "paycometOrder" TEXT,
    "refundedFromOrder" TEXT,
    "status" "WalletTxStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletSubscription" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "paymentMethodTokenId" INTEGER NOT NULL,
    "monthlyAmountCents" INTEGER NOT NULL,
    "feePerMonthCents" INTEGER NOT NULL DEFAULT 25,
    "totalMonths" INTEGER NOT NULL DEFAULT 9,
    "executedMonths" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "nextChargeAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscrowPayout" (
    "id" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "destinationType" "PayoutDestination" NOT NULL DEFAULT 'PROVIDER',
    "beneficiaryName" TEXT NOT NULL,
    "beneficiaryIban" TEXT NOT NULL,
    "providerCif" TEXT,
    "providerInvoiceFileId" TEXT,
    "netPaidCents" INTEGER NOT NULL,
    "korumFeeSettledCents" INTEGER NOT NULL,
    "paycometTransferId" TEXT,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING_DOUBLE_CHECK',
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResizePoll" (
    "id" SERIAL NOT NULL,
    "initiativeId" INTEGER NOT NULL,
    "optionsJson" JSONB NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "status" "ResizePollStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResizePoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResizeVote" (
    "id" SERIAL NOT NULL,
    "pollId" INTEGER NOT NULL,
    "canonicalEmail" TEXT NOT NULL,
    "optionIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResizeVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" SERIAL NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "series" TEXT NOT NULL DEFAULT 'K',
    "organizationId" TEXT NOT NULL,
    "sponsorId" INTEGER,
    "payoutId" INTEGER,
    "recipientName" TEXT NOT NULL,
    "recipientTaxId" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "baseAmountCents" INTEGER NOT NULL,
    "taxRateBps" INTEGER NOT NULL DEFAULT 2100,
    "taxAmountCents" INTEGER NOT NULL DEFAULT 0,
    "totalAmountCents" INTEGER NOT NULL,
    "prevVerifactuHash" TEXT,
    "verifactuHash" TEXT NOT NULL,
    "verifactuQrUrl" TEXT NOT NULL,
    "verifactuStatus" "InvoiceVerifactuStatus" NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "pdfFileId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" SERIAL NOT NULL,
    "ticketCode" TEXT NOT NULL,
    "organizationId" TEXT,
    "originLabel" TEXT NOT NULL,
    "senderEmail" TEXT,
    "target" "SupportTarget" NOT NULL DEFAULT 'SUPERADMIN',
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "replyMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "visibility" "FileVisibility" NOT NULL,
    "purpose" "FilePurpose" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "organizationId" TEXT,
    "uploadedById" TEXT,
    "retainUntil" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "AuditActorType" NOT NULL,
    "actorUserId" TEXT,
    "organizationId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "metadataJson" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" SERIAL NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
    "templateKey" TEXT NOT NULL,
    "locale" "Locale" NOT NULL DEFAULT 'es',
    "toAddress" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "payloadJson" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" SERIAL NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" SERIAL NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "subjectEmailHmac" TEXT,
    "purpose" "ConsentPurpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" SERIAL NOT NULL,
    "userId" TEXT,
    "requesterEmailHmac" TEXT NOT NULL,
    "type" "PrivacyRequestType" NOT NULL,
    "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'RECEIVED',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MedalTierConfig_rank_key" ON "MedalTierConfig"("rank");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalCategory_name_key" ON "GlobalCategory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_canonicalEmail_key" ON "User"("canonicalEmail");

-- CreateIndex
CREATE UNIQUE INDEX "User_walletExternalId_key" ON "User"("walletExternalId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "TwoFactor_userId_idx" ON "TwoFactor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Passkey_credentialID_key" ON "Passkey"("credentialID");

-- CreateIndex
CREATE INDEX "Passkey_userId_idx" ON "Passkey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimit_key_key" ON "RateLimit"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_cif_key" ON "Organization"("cif");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_walletId_key" ON "Organization"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_paycometSplitId_key" ON "Organization"("paycometSplitId");

-- CreateIndex
CREATE INDEX "OrganizationMember_organizationId_role_idx" ON "OrganizationMember"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_userId_organizationId_role_key" ON "OrganizationMember"("userId", "organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationCategory_organizationId_name_key" ON "OrganizationCategory"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Initiative_walletEscrowId_key" ON "Initiative"("walletEscrowId");

-- CreateIndex
CREATE INDEX "Initiative_organizationId_status_idx" ON "Initiative"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Initiative_status_closesAt_idx" ON "Initiative"("status", "closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "InitiativeCourseProgress_initiativeId_groupName_key" ON "InitiativeCourseProgress"("initiativeId", "groupName");

-- CreateIndex
CREATE INDEX "Sponsor_organizationId_status_idx" ON "Sponsor"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Idea_organizationId_phase_idx" ON "Idea"("organizationId", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "Device_cookieIdHash_key" ON "Device"("cookieIdHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceAccount_deviceId_userId_key" ON "DeviceAccount"("deviceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "IdeaSignatureAudit_ideaId_canonicalEmail_key" ON "IdeaSignatureAudit"("ideaId", "canonicalEmail");

-- CreateIndex
CREATE UNIQUE INDEX "DoubleCheckSignature_targetType_ideaId_signerRole_key" ON "DoubleCheckSignature"("targetType", "ideaId", "signerRole");

-- CreateIndex
CREATE UNIQUE INDEX "DoubleCheckSignature_targetType_payoutId_signerRole_key" ON "DoubleCheckSignature"("targetType", "payoutId", "signerRole");

-- CreateIndex
CREATE UNIQUE INDEX "Contribution_paycometOrder_key" ON "Contribution"("paycometOrder");

-- CreateIndex
CREATE INDEX "Contribution_initiativeId_status_idx" ON "Contribution"("initiativeId", "status");

-- CreateIndex
CREATE INDEX "Contribution_organizationId_fiscalYear_type_idx" ON "Contribution"("organizationId", "fiscalYear", "type");

-- CreateIndex
CREATE INDEX "Contribution_donorTaxIdHmac_fiscalYear_idx" ON "Contribution"("donorTaxIdHmac", "fiscalYear");

-- CreateIndex
CREATE INDEX "Contribution_canonicalEmail_idx" ON "Contribution"("canonicalEmail");

-- CreateIndex
CREATE UNIQUE INDEX "TicketPass_uuid_key" ON "TicketPass"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "TicketPass_contributionId_key" ON "TicketPass"("contributionId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketPass_serialCode_key" ON "TicketPass"("serialCode");

-- CreateIndex
CREATE UNIQUE INDEX "GateSession_tokenHash_key" ON "GateSession"("tokenHash");

-- CreateIndex
CREATE INDEX "TicketCheckIn_ticketPassId_createdAt_idx" ON "TicketCheckIn"("ticketPassId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerJournal_idempotencyKey_key" ON "LedgerJournal"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerJournal_reversesJournalId_key" ON "LedgerJournal"("reversesJournalId");

-- CreateIndex
CREATE INDEX "LedgerJournal_organizationId_occurredAt_idx" ON "LedgerJournal"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "LedgerJournal_initiativeId_idx" ON "LedgerJournal"("initiativeId");

-- CreateIndex
CREATE INDEX "EscrowLedgerEntry_account_organizationId_idx" ON "EscrowLedgerEntry"("account", "organizationId");

-- CreateIndex
CREATE INDEX "EscrowLedgerEntry_account_initiativeId_idx" ON "EscrowLedgerEntry"("account", "initiativeId");

-- CreateIndex
CREATE INDEX "EscrowLedgerEntry_account_userId_idx" ON "EscrowLedgerEntry"("account", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_paycometOrder_key" ON "WalletTransaction"("paycometOrder");

-- CreateIndex
CREATE INDEX "WalletTransaction_userId_createdAt_idx" ON "WalletTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletSubscription_active_nextChargeAt_idx" ON "WalletSubscription"("active", "nextChargeAt");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowPayout_initiativeId_key" ON "EscrowPayout"("initiativeId");

-- CreateIndex
CREATE UNIQUE INDEX "ResizePoll_initiativeId_key" ON "ResizePoll"("initiativeId");

-- CreateIndex
CREATE UNIQUE INDEX "ResizeVote_pollId_canonicalEmail_key" ON "ResizeVote"("pollId", "canonicalEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_verifactuHash_key" ON "Invoice"("verifactuHash");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_ticketCode_key" ON "SupportTicket"("ticketCode");

-- CreateIndex
CREATE UNIQUE INDEX "FileAsset_objectKey_key" ON "FileAsset"("objectKey");

-- CreateIndex
CREATE INDEX "FileAsset_organizationId_purpose_idx" ON "FileAsset"("organizationId", "purpose");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_occurredAt_idx" ON "AuditLog"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_occurredAt_idx" ON "AuditLog"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_occurredAt_idx" ON "AuditLog"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_externalEventId_key" ON "WebhookEvent"("provider", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_idempotencyKey_key" ON "OutboxMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_purpose_idx" ON "ConsentRecord"("userId", "purpose");

-- CreateIndex
CREATE INDEX "PrivacyRequest_status_dueAt_idx" ON "PrivacyRequest"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactor" ADD CONSTRAINT "TwoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passkey" ADD CONSTRAINT "Passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_logoFileId_fkey" FOREIGN KEY ("logoFileId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_bannerFileId_fkey" FOREIGN KEY ("bannerFileId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationCategory" ADD CONSTRAINT "OrganizationCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_coverFileId_fkey" FOREIGN KEY ("coverFileId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_beforeFileId_fkey" FOREIGN KEY ("beforeFileId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Initiative" ADD CONSTRAINT "Initiative_afterFileId_fkey" FOREIGN KEY ("afterFileId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitiativeCourseProgress" ADD CONSTRAINT "InitiativeCourseProgress_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_logoFileId_fkey" FOREIGN KEY ("logoFileId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sponsor" ADD CONSTRAINT "Sponsor_paymentMethodTokenId_fkey" FOREIGN KEY ("paymentMethodTokenId") REFERENCES "PaymentMethodToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Idea" ADD CONSTRAINT "Idea_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAccount" ADD CONSTRAINT "DeviceAccount_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAccount" ADD CONSTRAINT "DeviceAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaSignatureAudit" ADD CONSTRAINT "IdeaSignatureAudit_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaSignatureAudit" ADD CONSTRAINT "IdeaSignatureAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaSignatureAudit" ADD CONSTRAINT "IdeaSignatureAudit_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaMessage" ADD CONSTRAINT "IdeaMessage_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoubleCheckSignature" ADD CONSTRAINT "DoubleCheckSignature_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoubleCheckSignature" ADD CONSTRAINT "DoubleCheckSignature_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoubleCheckSignature" ADD CONSTRAINT "DoubleCheckSignature_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "EscrowPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoubleCheckSignature" ADD CONSTRAINT "DoubleCheckSignature_signerUserId_fkey" FOREIGN KEY ("signerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPass" ADD CONSTRAINT "TicketPass_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPass" ADD CONSTRAINT "TicketPass_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateSession" ADD CONSTRAINT "GateSession_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_ticketPassId_fkey" FOREIGN KEY ("ticketPassId") REFERENCES "TicketPass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_gateSessionId_fkey" FOREIGN KEY ("gateSessionId") REFERENCES "GateSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerJournal" ADD CONSTRAINT "LedgerJournal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerJournal" ADD CONSTRAINT "LedgerJournal_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerJournal" ADD CONSTRAINT "LedgerJournal_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerJournal" ADD CONSTRAINT "LedgerJournal_walletTxId_fkey" FOREIGN KEY ("walletTxId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerJournal" ADD CONSTRAINT "LedgerJournal_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "EscrowPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerJournal" ADD CONSTRAINT "LedgerJournal_reversesJournalId_fkey" FOREIGN KEY ("reversesJournalId") REFERENCES "LedgerJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowLedgerEntry" ADD CONSTRAINT "EscrowLedgerEntry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "LedgerJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethodToken" ADD CONSTRAINT "PaymentMethodToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_paymentMethodTokenId_fkey" FOREIGN KEY ("paymentMethodTokenId") REFERENCES "PaymentMethodToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletSubscription" ADD CONSTRAINT "WalletSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletSubscription" ADD CONSTRAINT "WalletSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletSubscription" ADD CONSTRAINT "WalletSubscription_paymentMethodTokenId_fkey" FOREIGN KEY ("paymentMethodTokenId") REFERENCES "PaymentMethodToken"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowPayout" ADD CONSTRAINT "EscrowPayout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowPayout" ADD CONSTRAINT "EscrowPayout_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowPayout" ADD CONSTRAINT "EscrowPayout_providerInvoiceFileId_fkey" FOREIGN KEY ("providerInvoiceFileId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResizePoll" ADD CONSTRAINT "ResizePoll_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResizeVote" ADD CONSTRAINT "ResizeVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "ResizePoll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "EscrowPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_pdfFileId_fkey" FOREIGN KEY ("pdfFileId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
