// Authoritative Backend Product Catalog & Entitlements Definition
// All pricing, INR currency conversion rates, and access boundaries are strictly defined here.

const USD_TO_INR_RATE = 85.0; // Standard baseline exchange rate: $1 USD = ₹85 INR

const PRODUCTS = {
  free: {
    id: 'free',
    name: 'Free Plan',
    badge: 'Unlimited',
    priceUsd: 0,
    priceInr: 0,
    billingInterval: 'forever',
    entitlements: {
      maxAuditedTools: Infinity,
      modelAuditorAccess: true,
      historyRetentionLimit: Infinity,
      pdfExportAllowed: true,
      detailedMigrationChecklists: true,
      priorityChatAssistant: true
    },
    features: [
      'Unlimited tools audited',
      'Standard Option A vs B comparison',
      'Full model capability benchmarks',
      'Audit history saving',
      'PDF exports and downloads',
      'Live AI Model Auditor access'
    ]
  },
  single_unlock: {
    id: 'single_unlock',
    name: 'Single Report Unlock',
    badge: 'One-Time',
    priceUsd: 19,
    priceInr: 1599,
    billingInterval: 'one_time',
    entitlements: {
      maxAuditedTools: Infinity,
      modelAuditorAccess: true,
      historyRetentionLimit: Infinity,
      pdfExportAllowed: true,
      detailedMigrationChecklists: true,
      priorityChatAssistant: true
    },
    features: [
      'Permanently unlocks all recommendations for selected report',
      'Full migration checklist & script access',
      'Saves unlocked report to account history'
    ]
  }
};

// Default Merchant UPI configuration
const UPI_CONFIG = {
  merchantVpa: process.env.MERCHANT_UPI_VPA || 'audexai@upi',
  merchantName: process.env.MERCHANT_UPI_NAME || 'Audex AI Optimiser',
  currency: 'INR'
};

module.exports = {
  USD_TO_INR_RATE,
  PRODUCTS,
  UPI_CONFIG
};
