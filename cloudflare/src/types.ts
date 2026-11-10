export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export interface InstitutionRow {
  id: number;
  name: string;
  status: string;
  cnpj: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  site: string | null;
  logo_filename: string | null;
  logo_content: string | null;
  signature_filename: string | null;
  signature_content: string | null;
  signatory_name: string | null;
  signatory_role: string | null;
  proof_filename: string | null;
  proof_content: string | null;
  proof_uploaded_at: string | null;
  updated_at: string | null;
}

export interface DonorRow {
  id: number;
  person_type: "PF" | "PJ";
  name: string;
  tax_id: string;
  email: string | null;
  phone: string | null;
  representative: string | null;
  created_at: string | null;
}

export interface DonationRow {
  id: number;
  number: string;
  donor_id: number;
  donation_type: "financeira" | "bem";
  received_at: string;
  purpose: string;
  payment_method: string | null;
  amount: number | null;
  description: string | null;
  quantity: number | null;
  estimated_value: number | null;
  brand_model: string | null;
  fiscal_document: string | null;
  notes: string | null;
  document_type: string;
  institution_status_snapshot: string;
  warning_applied: number;
  voided: number;
  void_reason: string | null;
  voided_at: string | null;
  created_at: string | null;
  // vindos do JOIN com donors
  donor_name?: string;
  donor_person_type?: "PF" | "PJ";
  donor_tax_id?: string;
  donor_email?: string | null;
  donor_phone?: string | null;
  donor_representative?: string | null;
}
