<div align="center">

<img src="./assets/Audex.png" alt="Audex AI Logo" width="160" />

# Audex AI — Backend API & Model Intelligence Engine

**Enterprise AI Spend Auditing, Model Benchmark Ranking, and Intelligent Token Migration Engine**

[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/dhrub4545/Audex_AI_backend)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18.x%20%7C%2020.x-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.19.2-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose%208.3.1-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Redis](https://img.shields.io/badge/Redis-ioredis%206.0.0-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
[![Vercel](https://img.shields.io/badge/Vercel-Serverless%20Ready-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://vercel.com/)

---

## ?? Application Screenshot & Interface Preview

<div align="center">
  <img src="./assets/screenshot.png" alt="Application Interface Preview" width="850" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);" />
</div>

---

### 🔗 Companion Repositories & Live Deployment

| Component | Link | Description |
| :--- | :--- | :--- |
| 🌐 **Frontend Application** | [![Frontend Repo](https://img.shields.io/badge/Repository-Audex__AI__frontend-blue?style=flat-square&logo=github)](https://github.com/dhrub4545/Audex_AI_frontend) | Modern React 19 + Vite analytics client |
| 🚀 **Live Production** | [![Live Platform](https://img.shields.io/badge/Production-www.audexai.in-emerald?style=flat-square&logo=vercel)](https://www.audexai.in) | Official production platform |

</div>

---

## 📌 Executive Summary & Problem Solved

Modern engineering teams, generative AI startups, and enterprise organizations face runaway AI infrastructure costs. Teams regularly deploy premier, high-cost models (such as GPT-4o or Claude 3.5 Sonnet) for routine background tasks—like basic text extraction, document classification, translation, or batch data summarization—where cost-effective alternatives (like Gemini 1.5 Flash, DeepSeek V3, or Mistral Small) deliver equivalent performance at **up to 90% lower token cost**.

Furthermore, software teams accumulate duplicate seat licenses across developer tools (Cursor Pro, GitHub Copilot, ChatGPT Plus, Claude Pro), causing substantial budget waste without centralized visibility.

**Audex AI Backend** is a high-performance REST API and intelligence engine designed to solve this dilemma:
1. **Automated Spend Auditing**: Ingests your organization's prompt volumes, token ratios, and model fleets to quantify current spend vs. optimized potential.
2. **Benchmark-Driven Recommendations**: Continuously ranks models across intelligence, coding, reasoning, math, speed, and cost using empirical evaluation datasets (MMLU, Arena Elo, HumanEval, SWE-bench).
3. **AI Copilot & Migration Engine**: Offers conversational auditing powered by LLM routing (Google Gemini, Groq, OpenRouter) and generates code-level API migration strategies.
4. **Subscription Seat Rationalization**: Tracks corporate subscriptions, detects overlap, and recommends consolidation paths.

---

## 🌟 Key Features

- 📊 **Empirical Model Ranking Engine**: Dynamically scores over 100+ LLMs across 20+ specialized domains (Coding, Reasoning, Fast, Cheap, Vision, Multilingual, Enterprise) using weighted evaluation indices.
- 💸 **Spend Optimization Algorithms**: Calculates immediate ROI, monthly token expenditure, projected annual savings, and efficiency scores (0–100).
- ⚡ **Multi-Tier Caching System (L1 Memory + L2 Redis)**: Sub-millisecond data delivery using in-memory TTL caching with seamless `ioredis` synchronization and automatic fallback.
- 🤖 **Interactive AI Auditor Copilot**: Conversational assistant grounded in live audit metrics and benchmark data, powered by Google Gemini with multi-provider fallbacks (OpenRouter, Groq).
- 🌐 **Robust SRV DNS Resolution**: Pre-configured with Google (`8.8.8.8`, `8.8.4.4`) and Cloudflare (`1.1.1.1`) DNS resolvers to prevent MongoDB Atlas SRV query timeouts on restrictive ISP/VPC networks.
- 💳 **Razorpay UPI & Subscription Integration**: Native payment intent creation, UPI QR code generation, webhook verification, and entitlement provisioning.
- 🛡️ **Tiered Express Rate Limiting**: Granular rate limiters safeguarding `/api/auth`, `/api/chats`, `/api/payment`, and `/api/audits`.
- ⏱️ **Automated Synchronization (Vercel Cron)**: Scheduled daily cron jobs (`0 0 * * *`) that fetch upstream benchmark datasets and refresh subscription tiers without manual intervention.

---

## 🏗️ System Architecture

The following diagram details the flow of incoming requests through security barriers, caching layers, business logic services, and persistence tiers:

```mermaid
flowchart TD
    subgraph ClientLayer["Client Layer"]
        UserBrowser["Web Client (React 19 / Vite)"]
        ExternalAPI["External API Consumers / Curl"]
    end

    subgraph SecurityMiddleware["Gateway & Security Middleware"]
        DNSResolver["Custom DNS Resolver (8.8.8.8 / 1.1.1.1)"]
        CorsHandler["CORS Configuration (audexai.in / localhost)"]
        RateLimiters["Rate Limiters (Auth: 60/15m, Chat: 60/1m, Payment: 60/1m, Audit: 120/1m)"]
        AuthMiddleware["JWT Authentication & Optional Auth Guard"]
    end

    subgraph RoutingLayer["API Routing Layer"]
        AuthRoutes["/api/auth (User Auth, OAuth, Entitlements)"]
        AuditRoutes["/api/audits (Audits, Models, Benchmarks, Crons)"]
        ChatRoutes["/api/chats (AI Copilot Chat Sessions)"]
        PaymentRoutes["/api/payment (Razorpay UPI, Webhooks, Billing)"]
        HealthRoutes["/api/health & / (System Diagnostics)"]
    end

    subgraph CoreServices["Intelligence & Business Services"]
        RankStorage["Rank Storage & Benchmark Aggregator"]
        RecommendationEngine["Cost & Recommendation Algorithm"]
        DailyPipeline["Daily Model Sync Pipeline"]
        AICopilotService["AI Auditor Service (Gemini / OpenRouter / Groq)"]
        PaymentService["Razorpay Payment Gateway Handler"]
    end

    subgraph CachingLayer["High-Performance Caching Tier"]
        L1Cache["L1 Cache: In-Memory TTL Map"]
        L2Cache["L2 Cache: Redis Cluster (ioredis)"]
    end

    subgraph PersistenceLayer["Data & Persistence Tier"]
        MongoDBAtlas[("MongoDB Atlas (Mongoose 8)")]
        LocalJSON[("Canonical Benchmark Backups (data/rank/*.json)")]
    end

    UserBrowser --> CorsHandler
    ExternalAPI --> CorsHandler
    CorsHandler --> DNSResolver
    DNSResolver --> RateLimiters
    RateLimiters --> AuthMiddleware

    AuthMiddleware --> AuthRoutes
    AuthMiddleware --> AuditRoutes
    AuthMiddleware --> ChatRoutes
    AuthMiddleware --> PaymentRoutes
    AuthMiddleware --> HealthRoutes

    AuditRoutes --> RecommendationEngine
    AuditRoutes --> RankStorage
    ChatRoutes --> AICopilotService
    PaymentRoutes --> PaymentService

    RankStorage <--> L1Cache
    L1Cache <--> L2Cache
    RankStorage <--> MongoDBAtlas
    RankStorage <--> LocalJSON

    DailyPipeline --> MongoDBAtlas
    AICopilotService --> MongoDBAtlas
    PaymentService --> MongoDBAtlas
```

---

## 🔄 Data Flow: Audit Generation & Optimization

The sequence diagram below illustrates an audit lifecycle from initial user fleet submission to benchmark calculation, AI recommendation, and persistent response caching:

```mermaid
sequenceDiagram
    autonumber
    actor User as Client / User
    participant Gateway as Express Gateway
    participant Limiter as Rate Limiter
    participant AuditRouter as Audit Controller
    participant Cache as Cache Service (L1 / L2)
    participant RankEngine as Recommendation Engine
    participant MongoDB as MongoDB Atlas
    participant LLM as Google Gemini / OpenRouter

    User->>Gateway: POST /api/audits (Model Fleet, Prompts, Seats)
    Gateway->>Limiter: Check audit request allowance (120 req/min)
    Limiter-->>Gateway: Allowed

    Gateway->>AuditRouter: Dispatch audit generation payload
    AuditRouter->>Cache: Request cached active models & pricing
    alt Cache Hit
        Cache-->>AuditRouter: Return cached model benchmark catalog
    else Cache Miss
        AuditRouter->>MongoDB: Fetch Model collection
        MongoDB-->>AuditRouter: Return model catalog
        AuditRouter->>Cache: Set cache (L1 Memory + L2 Redis)
    end

    AuditRouter->>RankEngine: Run overall_score & savings calculation
    RankEngine->>RankEngine: Map task requirements to optimal tier
    RankEngine-->>AuditRouter: Computed savings ($), ROI, and replacements

    AuditRouter->>LLM: Generate personalized migration action plan
    LLM-->>AuditRouter: Detailed technical migration roadmap

    alt User is Authenticated
        AuditRouter->>MongoDB: Save Audit record to user profile
        MongoDB-->>AuditRouter: Audit saved with unique ObjectId
    end

    AuditRouter-->>User: 200 OK (Full Audit Report, Recommendations, Action Plan)
```

---

## 💻 Tech Stack

| Domain | Technology | Version | Purpose |
| :--- | :--- | :--- | :--- |
| **Runtime** | Node.js | `>=18.x` / `20.x` | High-efficiency asynchronous JavaScript engine |
| **Framework** | Express.js | `4.19.2` | Core REST API web application framework |
| **Database** | MongoDB / Mongoose | `8.3.1` | Document storage with schema validation & connection caching |
| **Distributed Cache** | Redis / ioredis | `6.0.0` | Ultra-low latency L2 caching for model intelligence & tokens |
| **Authentication** | JSON Web Tokens & Bcrypt | `9.0.3` / `3.0.3` | Cryptographic password hashing and stateless token issuance |
| **AI Integration** | Google Gemini / OpenRouter | REST API | Multi-LLM synthesis and contextual audit chat assistance |
| **Payment Gateway** | Razorpay SDK | `2.9.8` | UPI dynamic order generation, signature verification, and billing |
| **Rate Limiting** | express-rate-limit | `8.7.0` | IP-based request throttling against brute force and abuse |
| **Task Scheduling** | node-cron | `4.2.1` | Background synchronization of LLM benchmark rankings |
| **Cloud Deployment** | Vercel Serverless | V2 Platform | Scalable serverless API runtime with automated edge rewrites |

---

## 📂 Repository Structure

```text
Audex_AI_backend/
├── api/
│   └── index.js                      # Vercel serverless function entrypoint
├── assets/
│   └── Audex.png                     # Official Audex AI logo banner
├── audex-ai/
│   ├── algorithms/
│   │   ├── overall_score.js          # Multi-factor model scoring algorithm
│   │   └── weights.json              # Domain evaluation weights (Coding, Math, Speed, etc.)
│   ├── collectors/
│   │   └── runCollectors.js          # Ingestion scripts for external benchmark data
│   └── scheduler/
│       └── update.js                 # Scheduled model score updater
├── config/
│   └── products.js                   # Subscription tiers (ChatGPT, Claude, Cursor, Copilot)
├── data/
│   ├── rank/                         # Cached JSON rankings (coding, math, cheap, fast, etc.)
│   ├── raw_data.json                 # Baseline evaluation snapshot
│   └── subscription_tiers.json       # Canonical pricing for developer AI subscriptions
├── jobs/
│   └── scheduler.js                  # node-cron initialization for standalone server mode
├── middleware/
│   ├── auth.js                       # JWT verification and optional authentication middleware
│   └── entitlements.js               # Plan access control and tier validation
├── models/
│   ├── Audit.js                      # Audit report schema (fleet, spend, savings, actions)
│   ├── Chat.js                       # Conversational message history per audit session
│   ├── Model.js                      # Model catalog (provider, slug, token pricing, benchmarks)
│   ├── PaymentTransaction.js         # Razorpay UPI transaction records
│   ├── RankData.js                   # Snapshot schema for category leaderboard data
│   └── User.js                       # User credentials, subscriptionTier, credits, history
├── routes/
│   ├── auditRoutes.js                # Core audit, recommendation, model comparison & cron endpoints
│   ├── authRoutes.js                 # Registration, login, profile, and OAuth endpoints
│   ├── chatRoutes.js                 # Copilot conversational assistant endpoints
│   └── paymentRoutes.js              # UPI orders, verification, and Razorpay webhook handlers
├── scripts/
│   └── generateCanonicalSample.js    # Data utility for canonical seed generation
├── services/
│   ├── artificialAnalysisScraper.js  # Scraper client for Artificial Analysis benchmark data
│   ├── artificialAnalysisSync.js     # Sync handler mapping external data to Model documents
│   ├── cacheService.js               # Dual-layer caching service (L1 Map + L2 ioredis)
│   ├── dailyRankingPipeline.js       # Daily synchronization pipeline handler
│   ├── rankStorage.js                # Disk and DB abstraction for category rankings
│   ├── subscriptionTierSync.js       # Dynamic updates for subscription seat pricing
│   └── webSearch.js                  # Fallback web scraping & intelligence gatherer
├── .gitignore
├── nodemon.json
├── package.json
├── server.js                         # Standalone Express server bootstrap & DNS setup
└── vercel.json                       # Serverless routing, header policies & cron config
```

---

## 🛠️ Local Setup & Installation

### Prerequisites
- **Node.js**: `v18.x` or `v20.x` installed ([Download Node.js](https://nodejs.org/))
- **MongoDB**: Local MongoDB instance or free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster URI
- **Redis** *(Optional, recommended)*: Local Redis instance or [Upstash](https://upstash.com/) Redis URL (backend falls back to in-memory caching if omitted)

### Step-by-Step Installation

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/dhrub4545/Audex_AI_backend.git
   cd Audex_AI_backend
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file in the root directory:
   ```bash
   cp .env.example .env   # Or create .env manually
   ```
   Populate `.env` with your credentials (see table below).

4. **Launch Development Server**:
   ```bash
   npm run dev
   ```
   The API will initialize on `http://localhost:5000` with active nodemon hot-reloading.

5. **Verify System Health**:
   Visit `http://localhost:5000/api/health` in your browser or execute:
   ```bash
   curl http://localhost:5000/api/health
   ```

---

## 🔐 Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `PORT` | No | `5000` | Port for the standalone Express HTTP server |
| `NODE_ENV` | No | `development` | Server runtime environment (`development` \| `production`) |
| `MONGODB_URI` | **Yes** | `mongodb://localhost:27017/audit-ai` | MongoDB Atlas SRV connection string |
| `JWT_SECRET` | **Yes** | `—` | Secret key used to sign and verify user JWTs |
| `FRONTEND_URL` | No | `http://localhost:5173` | Allowed CORS origin (supports production domain `https://www.audexai.in`) |
| `REDIS_URL` | No | `—` | Redis connection URL (`redis://default:pass@host:port`) |
| `REDIS_HOST` | No | `127.0.0.1` | Standalone Redis server host (if `REDIS_URL` not set) |
| `REDIS_PORT` | No | `6379` | Standalone Redis server port |
| `REDIS_PASSWORD`| No | `—` | Password for Redis authentication |
| `GEMINI_API_KEY`| No | `—` | Google Gemini API key for AI audit copilot & action plans |
| `OPENROUTER_API_KEY`| No | `—` | OpenRouter API key for secondary LLM model fallback |
| `GROQ_API_KEY` | No | `—` | Groq API key for high-speed inference fallbacks |
| `RAZORPAY_KEY_ID` | No | `—` | Razorpay API key ID for payment processing |
| `RAZORPAY_KEY_SECRET` | No | `—` | Razorpay API secret key for payment verification |
| `MERCHANT_UPI_VPA` | No | `—` | Merchant Virtual Payment Address for direct UPI QR code generation |
| `MERCHANT_UPI_NAME`| No | `Audex AI` | Registered business name displayed during UPI checkout |
| `CRON_SECRET` | No | `—` | Bearer token to authorize Vercel Cron invocation (`/api/audits/cron/sync`) |
| `ADMIN_SECRET` | No | `—` | Secret key for triggering administrative syncs (`/api/audits/admin/sync`) |

---

## 📡 Complete API Reference

### 1. Authentication & User (`/api/auth`)

| Endpoint | Method | Auth | Rate Limit | Description |
| :--- | :---: | :---: | :---: | :--- |
| `/api/auth/register` | `POST` | None | 60 / 15m | Register a new user account with email, password, and organization |
| `/api/auth/login` | `POST` | None | 60 / 15m | Authenticate user and receive signed JWT token |
| `/api/auth/me` | `GET` | Bearer | 60 / 15m | Get authenticated user profile, tier, and remaining audit credits |
| `/api/auth/purchase` | `POST` | Bearer | 60 / 15m | Process credits purchase or tier upgrade |
| `/api/auth/subscribe` | `POST` | Bearer | 60 / 15m | Activate or change user subscription plan |
| `/api/auth/unlock-audit` | `POST` | Bearer | 60 / 15m | Unlock complete analysis and export tools for a specific audit |
| `/api/auth/google` | `GET` | None | Standard | Initialize Google OAuth 2.0 authentication flow |
| `/api/auth/google/callback` | `GET` | None | Standard | Handle Google OAuth redirect and issue JWT |
| `/api/auth/github` | `GET` | None | Standard | Initialize GitHub OAuth authentication flow |
| `/api/auth/github/callback` | `GET` | None | Standard | Handle GitHub OAuth callback and authenticate user |
| `/api/auth/entitlements` | `GET` | None | Standard | Fetch subscription plan matrix and feature availability |

### 2. Audits, Models & Benchmarks (`/api/audits`)

| Endpoint | Method | Auth | Rate Limit | Description |
| :--- | :---: | :---: | :---: | :--- |
| `/api/audits` | `POST` | Optional | 120 / 1m | Run comprehensive AI audit on submitted model fleet and seat counts |
| `/api/audits` | `GET` | Bearer | 120 / 1m | List all previous audits associated with authenticated user |
| `/api/audits/:id` | `GET` | Optional | 120 / 1m | Retrieve detailed audit report by unique ID |
| `/api/audits/:id` | `DELETE` | Bearer | 120 / 1m | Delete an audit from the user's saved history |
| `/api/audits/:id/options` | `PUT` | Bearer | 120 / 1m | Update audit settings or recalibrate recommendations |
| `/api/audits/audit-recommendation` | `POST` | None | 120 / 1m | Compute targeted replacement model recommendations for a workload |
| `/api/audits/models/list` | `GET` | None | 120 / 1m | Fetch complete catalog of evaluated models with pricing & benchmarks |
| `/api/audits/compare/report` | `POST` | Optional | 120 / 1m | Generate side-by-side comparative analysis between 2–4 models |
| `/api/audits/analysis/raw-data` | `GET` | None | 120 / 1m | Retrieve raw evaluation metrics from external benchmark sources |
| `/api/audits/subscription-tiers/list` | `GET` | None | 120 / 1m | Fetch developer subscription pricing (ChatGPT Plus, Cursor, Copilot) |
| `/api/audits/cron/sync` | `GET/POST`| Cron Secret | Standard | Vercel Cron endpoint to sync model benchmarks and leaderboard data |
| `/api/audits/admin/sync` | `POST` | Admin Secret| Standard | Force manual refresh of all model pricing and evaluations |
| `/api/audits/cache/stats` | `GET` | None | Standard | Inspect L1 and L2 cache hit/miss rates and Redis connection state |
| `/api/audits/cache/clear` | `POST` | Admin Secret| Standard | Invalidate all cached benchmark and catalog keys |

### 3. AI Auditor Copilot (`/api/chats`)

| Endpoint | Method | Auth | Rate Limit | Description |
| :--- | :---: | :---: | :---: | :--- |
| `/api/chats/:auditId` | `GET` | Optional | 60 / 1m | Retrieve complete conversational chat history for an audit session |
| `/api/chats/:auditId` | `POST` | Optional | 60 / 1m | Send user prompt to AI Auditor; receives tailored migration advice |
| `/api/chats/:auditId` | `DELETE` | Bearer | 60 / 1m | Clear chat message history for an audit session |

### 4. Payments & Billing (`/api/payment`)

| Endpoint | Method | Auth | Rate Limit | Description |
| :--- | :---: | :---: | :---: | :--- |
| `/api/payment/plans` | `GET` | None | Standard | List available subscription tiers, pricing, and features |
| `/api/payment/create-upi-order` | `POST` | Bearer | 60 / 1m | Create dynamic Razorpay UPI order and generate payment intent |
| `/api/payment/verify-upi-payment` | `POST` | Bearer | 60 / 1m | Verify cryptographic payment signature and upgrade account |
| `/api/payment/webhook` | `POST` | Signature | None | Razorpay server-to-server webhook handler for payment events |
| `/api/payment/subscription-status`| `GET` | Bearer | 60 / 1m | Get active subscription billing period, status, and renewal date |
| `/api/payment/cancel-subscription` | `POST` | Bearer | 60 / 1m | Cancel active subscription renewal |

### 5. Diagnostics & Health

| Endpoint | Method | Auth | Description |
| :--- | :---: | :---: | :--- |
| `/api/health` | `GET` | None | Returns server health status, timestamp, and MongoDB readiness state |
| `/` | `GET` | None | Root status payload, database mode, and cache performance statistics |

---

## 🚀 Production Deployment

### Option A: Vercel Serverless (Recommended)

This repository includes a production-configured `vercel.json` supporting zero-configuration deployments:

1. Import the repository in your [Vercel Dashboard](https://vercel.com).
2. Set the Environment Variables (`MONGODB_URI`, `JWT_SECRET`, `FRONTEND_URL`, `GEMINI_API_KEY`, etc.).
3. Deploy! Vercel will map all incoming routes to `api/index.js` and schedule the daily sync cron job (`0 0 * * *`).

```bash
# Or deploy via Vercel CLI
npm install -g vercel
vercel --prod
```

### Option B: Docker Container

Create a `Dockerfile` in the project root:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 5000
ENV NODE_ENV=production
CMD ["node", "server.js"]
```

Build and run:
```bash
docker build -t audex-ai-backend .
docker run -d -p 5000:5000 --env-file .env --name audex-backend audex-ai-backend
```

### Option C: Production Node.js with PM2

```bash
npm install -g pm2
pm2 start server.js --name "audex-api" -i max
pm2 save
pm2 startup
```

---

## 🛡️ Security, Performance & Best Practices

1. **SRV DNS Overrides**:
   Node.js on certain cloud environments or local ISPs encounters issues resolving MongoDB Atlas SRV (`mongodb+srv://`) connection strings. Audex AI overrides default DNS resolution at startup using Google (`8.8.8.8`, `8.8.4.4`) and Cloudflare (`1.1.1.1`) to ensure 99.99% database connection reliability:
   ```javascript
   dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
   ```

2. **Serverless Connection Caching**:
   To prevent MongoDB connection exhaustion during serverless cold starts on Vercel, the backend implements global connection pooling (`global.mongooseConnection`) that reuses active database sockets across invocations.

3. **Multi-Tier Caching Hierarchy**:
   Every model and benchmark query first hits an **L1 in-memory TTL map**. If missing, it checks **L2 Redis**. Only on a complete cache miss does it query MongoDB Atlas or read disk backups, drastically reducing database load and response latency (<15ms).

4. **Granular Request Rate Limiting**:
   Brute-force protection is enforced via `express-rate-limit` across distinct windows:
   - **Authentication**: 60 requests per 15-minute window.
   - **AI Chat & Payments**: 60 requests per minute to prevent API exhaustion.
   - **Audits**: 120 requests per minute to accommodate high-volume enterprise testing.

5. **Security Headers**:
   Every response enforces strict HTTP security headers:
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: SAMEORIGIN`
   - `X-XSS-Protection: 1; mode=block`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Cache-Control: no-store, no-cache, must-revalidate`

---

## 👥 Authors & Licensing

Developed with ❤️ by the **Audex AI Team** ([@dhrub4545](https://github.com/dhrub4545)).  
Distributed under the **MIT License**. See `LICENSE` for details.
