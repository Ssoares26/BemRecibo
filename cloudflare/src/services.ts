/**
 * Regras de formatação compartilhadas — porte fiel do backend Python
 * (backend/bemrecibo/services.py), mantendo o mesmo resultado nos documentos.
 */

const UNITS = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const TEENS = [
  "dez", "onze", "doze", "treze", "catorze", "quinze",
  "dezesseis", "dezessete", "dezoito", "dezenove",
];
const TENS = [
  "", "", "vinte", "trinta", "quarenta", "cinquenta",
  "sessenta", "setenta", "oitenta", "noventa",
];
const HUNDREDS = [
  "", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos",
  "seiscentos", "setecentos", "oitocentos", "novecentos",
];
const SCALES: Array<[number, string, string]> = [
  [1_000_000_000, "bilhão", "bilhões"],
  [1_000_000, "milhão", "milhões"],
];

export const STATUS_LABELS: Record<string, string> = {
  habilitada: "Instituição habilitada",
  nao_habilitada: "Pré-habilitação",
};

export const WARNING_TEXT =
  "ADVERTÊNCIA: no cenário de pré-habilitação, esta doação não é dedutível do " +
  "Imposto sobre a Renda da Pessoa Jurídica (IRPJ). Texto demonstrativo sujeito " +
  "à validação contábil e jurídica.";

export const VOID_NOTICE =
  "DOCUMENTO CANCELADO — este registro foi anulado no sistema e não possui " +
  "validade para fins de comprovação de doação.";

function below100(value: number): string {
  if (value < 10) return UNITS[value];
  if (value < 20) return TEENS[value - 10];
  const tens = Math.floor(value / 10);
  const units = value % 10;
  return TENS[tens] + (units ? ` e ${UNITS[units]}` : "");
}

function below1000(value: number): string {
  if (value === 0) return "";
  if (value === 100) return "cem";
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(HUNDREDS[hundreds]);
  if (rest) parts.push(below100(rest));
  return parts.join(" e ");
}

function joinGroups(groups: Array<[string, number]>): string {
  if (!groups.length) return "zero";
  if (groups.length === 1) return groups[0][0];

  const [lastText, lastValue] = groups[groups.length - 1];
  const useAnd = lastValue < 100 || lastValue % 100 === 0;
  const previous = groups.slice(0, -1).map(([text]) => text);

  if (groups.length === 2) {
    return useAnd ? `${previous[0]} e ${lastText}` : `${previous[0]} ${lastText}`;
  }
  return previous.join(", ") + (useAnd ? " e " : ", ") + lastText;
}

export function integerToWords(value: number): string {
  const number = Math.trunc(value);
  if (number < 0) throw new Error("Valor negativo não pode ser escrito por extenso.");
  if (number === 0) return "zero";

  const groups: Array<[string, number]> = [];
  let remaining = number;

  for (const [scale, singular, plural] of SCALES) {
    if (remaining >= scale) {
      const quantity = Math.floor(remaining / scale);
      remaining %= scale;
      groups.push([`${below1000(quantity)} ${quantity === 1 ? singular : plural}`, quantity * scale]);
    }
  }

  if (remaining >= 1000) {
    const quantity = Math.floor(remaining / 1000);
    remaining %= 1000;
    groups.push([quantity === 1 ? "mil" : `${below1000(quantity)} mil`, quantity * 1000]);
  }

  if (remaining > 0) groups.push([below1000(remaining), remaining]);

  return joinGroups(groups);
}

export function numberToWordsPt(value: number | null | undefined): string {
  const amount = Math.round(Number(value || 0) * 100) / 100;
  if (amount < 0) throw new Error("Valor negativo não pode ser escrito por extenso.");

  const reais = Math.trunc(amount);
  const centavos = Math.round((amount - reais) * 100);

  const currency = (words: string, singular: string, plural: string): string => {
    const lastWord = words.split(" ").pop() || "";
    if (["milhão", "milhões", "bilhão", "bilhões"].includes(lastWord)) return `${words} de ${plural}`;
    return `${words} ${words === "um" ? singular : plural}`;
  };

  const chunks: string[] = [];
  if (reais) chunks.push(currency(integerToWords(reais), "real", "reais"));
  if (centavos) chunks.push(currency(integerToWords(centavos), "centavo", "centavos"));
  return chunks.length ? chunks.join(" e ") : "zero real";
}

export function valueInWords(value: number | null | undefined): string {
  const words = numberToWordsPt(value);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function brl(value: number | null | undefined): string {
  const amount = Math.round(Number(value || 0) * 100) / 100;
  const formatted = amount.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `R$ ${formatted}`;
}

export function onlyDigits(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D+/g, "");
}

export function formatTaxId(value: string | null | undefined): string {
  const digits = onlyDigits(value);
  if (!digits) return value ?? "";
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return value ?? "";
}

export function formatDateBr(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [year, month, day] = String(iso).slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(iso);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatDateTimeBr(iso: string | null | undefined): string {
  if (!iso) return "—";
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return formatDateBr(iso);
  const [, y, mo, d, h, mi] = match;
  return `${d}/${mo}/${y} ${h}:${mi}`;
}

export async function verificationCode(seed: string): Promise<string> {
  const data = new TextEncoder().encode(seed);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .slice(0, 12);
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Converte um traveler de data em ISO yyyy-mm-dd, aceitando já formatado. */
export function toIsoDate(value: string): string {
  const trimmed = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const br = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return trimmed;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function detectImageType(content: Uint8Array): "png" | "jpeg" | null {
  if (content.length > 8 && content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4e && content[3] === 0x47) {
    return "png";
  }
  if (content.length > 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "jpeg";
  return null;
}
