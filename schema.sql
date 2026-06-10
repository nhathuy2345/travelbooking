PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  email TEXT DEFAULT '',
  balance INTEGER DEFAULT 0 CHECK (balance >= 0),
  total_deposited INTEGER DEFAULT 0,
  total_spent INTEGER DEFAULT 0,
  is_locked INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  udid TEXT NOT NULL,
  name TEXT DEFAULT 'iOS Device',
  model TEXT DEFAULT 'iPhone',
  package_id INTEGER NOT NULL,
  status TEXT DEFAULT 'REGISTERED',
  registered_at TEXT NOT NULL,
  deleted_at TEXT DEFAULT NULL,
  FOREIGN KEY(username) REFERENCES users(username)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  package_id INTEGER DEFAULT NULL,
  udid TEXT DEFAULT NULL,
  device_id TEXT DEFAULT NULL,
  status TEXT DEFAULT 'PENDING',
  note TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT DEFAULT NULL,
  FOREIGN KEY(username) REFERENCES users(username)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_username ON devices(username);
CREATE INDEX IF NOT EXISTS idx_devices_udid ON devices(udid);
CREATE INDEX IF NOT EXISTS idx_transactions_username ON transactions(username);

INSERT OR IGNORE INTO settings (key, value) VALUES ('config', '{"muacertToken":"","pay2sPartnerCode":"","pay2sAccessKey":"","pay2sSecretKey":"","pay2sBankAccount":"","pay2sBankCode":"MB","pay2sAccountName":"","isSandbox":true,"adminUsername":"admin","adminPassword":"admin123","jwtSecret":"muacert_super_secret_key_2026","supportUrl":"https://t.me/your_telegram","termsUrl":"/terms.html","privacyUrl":"/privacy.html","refundUrl":"/refund.html","sellingPrices":{"1":180000,"2":120000,"3":70000}}');

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_devices_username ON devices(username);
CREATE INDEX IF NOT EXISTS idx_transactions_username ON transactions(username);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);

CREATE TABLE IF NOT EXISTS tours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  description TEXT,
  duration TEXT,
  price INTEGER NOT NULL,
  image_url TEXT,
  latitude REAL,
  longitude REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tour_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  people_count INTEGER DEFAULT 1,
  departure_date TEXT,
  note TEXT,
  status TEXT DEFAULT 'PENDING',
  total_price INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(username) REFERENCES users(username),
  FOREIGN KEY(tour_id) REFERENCES tours(id)
);

CREATE INDEX IF NOT EXISTS idx_bookings_username ON bookings(username);
CREATE INDEX IF NOT EXISTS idx_bookings_tour ON bookings(tour_id);