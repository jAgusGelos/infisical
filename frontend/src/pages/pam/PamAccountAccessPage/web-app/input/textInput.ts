import {
  MAX_UPSTREAM_PAYLOAD,
  type TInputEvent,
  type TSessionPolicy
} from "@app/lib/pam-web-app/contract";

export const MAX_PASTE_BYTES = 1024 * 1024;

const INITIAL_PART_CHARS = 16_384;

const encoder = new TextEncoder();
const BATCH_OVERHEAD = encoder.encode('{"events":[]}').length;

type TPasteEvent = Extract<TInputEvent, { t: "paste" }>;

export const buildImeEvent = (data: string, ts: number): TInputEvent | null => {
  const text = data.normalize("NFC");
  return text ? { t: "ime", text, ts } : null;
};

export const isPasteAllowed = (policy: TSessionPolicy | undefined) =>
  policy?.clipboard === "to_remote" || policy?.clipboard === "both";

const fitsInPayload = (event: TPasteEvent) =>
  BATCH_OVERHEAD + encoder.encode(JSON.stringify(event)).length <= MAX_UPSTREAM_PAYLOAD;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// Never cut between the two halves of a surrogate pair, or the part is not valid UTF-16.
const safeCut = (text: string, start: number, length: number) => {
  const end = Math.min(text.length, start + length);
  return end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
};

const splitIntoParts = (text: string, template: TPasteEvent) => {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let length = INITIAL_PART_CHARS;
    let end = safeCut(text, start, length);
    // JSON escaping can grow a part up to 6x (control characters), so shrink until it fits.
    while (!fitsInPayload({ ...template, text: text.slice(start, end) })) {
      length = Math.floor(length / 2);
      end = safeCut(text, start, length);
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
};

export const buildPasteEvents = (
  text: string,
  id: string,
  ts: number
): TPasteEvent[] | "too_large" => {
  if (!text) return [];
  if (encoder.encode(text).length > MAX_PASTE_BYTES) return "too_large";
  const template: TPasteEvent = { t: "paste", id, part: 0, total: 0, text: "", ts };
  const parts = splitIntoParts(text, { ...template, part: 99_999, total: 99_999 });
  return parts.map((part, index) => ({
    ...template,
    part: index,
    total: parts.length,
    text: part
  }));
};
