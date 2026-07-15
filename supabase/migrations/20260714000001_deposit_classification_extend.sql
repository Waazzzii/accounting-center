-- =============================================================================
-- 20260714000001_deposit_classification_extend.sql
-- Extend bank_deposit_classification with values observed in real BofC feed
-- data (2,723 lines, Jun 1 – Jul 14 2026): tax remittances (AZ DOR, City of
-- Palm Springs TOT) and vendor payments need their own buckets.
-- =============================================================================

ALTER TYPE bank_deposit_classification ADD VALUE IF NOT EXISTS 'tax_remittance';
ALTER TYPE bank_deposit_classification ADD VALUE IF NOT EXISTS 'vendor_payment';
