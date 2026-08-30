// Authoritative Backend Product Catalog & Entitlements Definition
// All pricing, INR currency conversion rates, and access boundaries are strictly defined here.

const USD_TO_INR_RATE = 85.0; // Standard baseline exchange rate: $1 USD = ₹85 INR

const PRODUCTS = {
  free: {
    id: 'free',
    name: 'Free Tier',
    badge: 'Free',
    priceUsd: 0,
    priceInr: 0,
    billingInterval: 'forever',
    entitlements: {
      maxAuditedTools: 2,
      modelAuditorAccess: false,
      historyRetentionLimit: 0,
      pdfExportAllowed: false,
      detailedMigrationChecklists: false,
      priorityChatAssistant: false
    },
    features: [
      'Audit up to 2 tools',
      'Standard Option A vs B comparison',
      'Basic model capability rating',
      'No audit history saving'
    ]
  },
  pro: {
    id: 'pro',
    name: 'Professional Plan',
    badge: 'Most Popular',
    priceUsd: 29,
    priceInr: 2499,
    billingInterval: 'month',
    entitlements: {
      maxAuditedTools: 15,
      modelAuditorAccess: false,
      historyRetentionLimit: 10,
      pdfExportAllowed: true,
      detailedMigrationChecklists: true,
      priorityChatAssistant: true
    },
    features: [
      'Audit up to 15 tools',
      'Detailed report & migration checklists',
      'Saves last 10 audits to history',
      'PDF exports and downloads',
      'Priority AI spend assistant'
    ]
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise Plan',
    badge: 'Full Access',
    priceUsd: 99,
    priceInr: 8499,
    billingInterval: 'month',
    entitlements: {
      maxAuditedTools: Infinity,
      modelAuditorAccess: true,
      historyRetentionLimit: Infinity,
      pdfExportAllowed: true,
      detailedMigrationChecklists: true,
      priorityChatAssistant: true
    },
    features: [
      'Live AI Model Auditor Access',
      'Unlimited tools audited',
      'Continuous monitoring dashboard',
      'API integrations enabled',
      'Unlimited audit history retention',
      'Team seat allocation controls'
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
      maxAuditedTools: 15,
      modelAuditorAccess: false,
      historyRetentionLimit: 1,
      pdfExportAllowed: true,
      detailedMigrationChecklists: true,
      priorityChatAssistant: false
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
