-- Esquema lógico do banco SQLite do BemRecibo.
-- Documentação de referência: o schema é criado automaticamente pelos modelos
-- SQLAlchemy em backend/bemrecibo/models.py. As colunas adicionadas depois da
-- primeira versão são aplicadas por migração leve em backend/bemrecibo/database.py.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS institution (
  id INTEGER PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'nao_habilitada',
  cnpj VARCHAR(20),
  address VARCHAR(200),
  city VARCHAR(120),
  phone VARCHAR(40),
  email VARCHAR(180),
  site VARCHAR(180),
  proof_filename VARCHAR(255),
  proof_content TEXT,
  proof_uploaded_at DATETIME,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS donors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_type VARCHAR(2) NOT NULL CHECK(person_type IN ('PF','PJ')),
  name VARCHAR(180) NOT NULL,
  tax_id VARCHAR(30) NOT NULL UNIQUE,
  email VARCHAR(180),
  phone VARCHAR(40),
  representative VARCHAR(180),
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number VARCHAR(30) NOT NULL UNIQUE,
  donor_id INTEGER NOT NULL REFERENCES donors(id),
  donation_type VARCHAR(20) NOT NULL CHECK(donation_type IN ('financeira','bem')),
  received_at DATE NOT NULL,
  purpose VARCHAR(250) NOT NULL,
  payment_method VARCHAR(100),
  amount NUMERIC,
  description TEXT,
  quantity INTEGER,
  estimated_value NUMERIC,
  brand_model VARCHAR(160),
  fiscal_document VARCHAR(100),
  notes TEXT,
  document_type VARCHAR(60) NOT NULL,
  institution_status_snapshot VARCHAR(30) NOT NULL,
  warning_applied BOOLEAN NOT NULL DEFAULT 1,
  voided BOOLEAN NOT NULL DEFAULT 0,
  void_reason VARCHAR(250),
  voided_at DATETIME,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL REFERENCES donations(id),
  document_type VARCHAR(60) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  created_at DATETIME
);

CREATE INDEX IF NOT EXISTS ix_donors_tax_id ON donors(tax_id);
CREATE INDEX IF NOT EXISTS ix_donations_number ON donations(number);
CREATE INDEX IF NOT EXISTS ix_donations_donor_id ON donations(donor_id);
CREATE INDEX IF NOT EXISTS ix_donations_received_at ON donations(received_at);
