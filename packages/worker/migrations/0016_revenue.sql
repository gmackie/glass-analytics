-- Revenue analytics: ECB exchange rates, Stripe connections and the Stripe customer → person map.

-- Units of `currency` per euro on `day` (YYYY-MM-DD), from the ECB reference rates.
CREATE TABLE IF NOT EXISTS fx_rates (
  day TEXT NOT NULL,
  currency TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (day, currency)
);

CREATE TABLE IF NOT EXISTS stripe_accounts (
  project TEXT PRIMARY KEY,
  -- personKey, groupType, groupKey, linkByEmail (JSON)
  config TEXT NOT NULL DEFAULT '{}',
  -- webhookSecret and an optional restricted API key, AES-GCM encrypted
  secrets TEXT,
  events INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Who a Stripe customer is in Dataflare (from customer.metadata, an email match or an API lookup).
CREATE TABLE IF NOT EXISTS stripe_customers (
  project TEXT NOT NULL,
  customer TEXT NOT NULL,
  person TEXT,
  grp TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, customer)
);
