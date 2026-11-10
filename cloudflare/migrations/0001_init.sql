-- Esquema do BemRecibo no Cloudflare D1 (SQLite gerenciado).
-- Aplicar com: npx wrangler d1 migrations apply bemrecibo --remote

CREATE TABLE IF NOT EXISTS institution (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Instituto Pelo Bem',
  status TEXT NOT NULL DEFAULT 'nao_habilitada' CHECK (status IN ('nao_habilitada', 'habilitada')),
  cnpj TEXT,
  address TEXT,
  city TEXT,
  phone TEXT,
  email TEXT,
  site TEXT,
  logo_filename TEXT,
  logo_content TEXT,
  signature_filename TEXT,
  signature_content TEXT,
  signatory_name TEXT,
  signatory_role TEXT,
  proof_filename TEXT,
  proof_content TEXT,
  proof_uploaded_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS donors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_type TEXT NOT NULL CHECK (person_type IN ('PF', 'PJ')),
  name TEXT NOT NULL,
  tax_id TEXT NOT NULL UNIQUE,
  email TEXT,
  phone TEXT,
  representative TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  donor_id INTEGER NOT NULL REFERENCES donors(id),
  donation_type TEXT NOT NULL CHECK (donation_type IN ('financeira', 'bem')),
  received_at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  payment_method TEXT,
  amount REAL,
  description TEXT,
  quantity INTEGER,
  estimated_value REAL,
  brand_model TEXT,
  fiscal_document TEXT,
  notes TEXT,
  document_type TEXT NOT NULL,
  institution_status_snapshot TEXT NOT NULL,
  warning_applied INTEGER NOT NULL DEFAULT 1,
  voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  voided_at TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL REFERENCES donations(id),
  document_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_donors_tax_id ON donors(tax_id);
CREATE INDEX IF NOT EXISTS ix_donations_number ON donations(number);
CREATE INDEX IF NOT EXISTS ix_donations_donor_id ON donations(donor_id);
CREATE INDEX IF NOT EXISTS ix_donations_received_at ON donations(received_at);

INSERT OR IGNORE INTO institution (id, name, status) VALUES (1, 'Instituto Pelo Bem', 'nao_habilitada');
