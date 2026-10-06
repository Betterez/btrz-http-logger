"use strict";

const MASK_CHAR = "x";
const MAX_DEPTH = 64;
const TRUNCATED = "[TRUNCATED]";

const URL_ENCODED_SEPARATOR = /%20|%2[bBdD]/g;
const CARD_NUMBER_CANDIDATE = /(?<![0-9A-Za-z])\d(?:(?:[ +-]|%20|%2[bBdD])?\d){12,18}(?![0-9A-Za-z])/g;
const TRACK_DATA = [
  /%B\d{13,19}\^[^^]{0,26}\^[^?]{0,80}\?/g,
  /;\d{13,19}=\d{0,40}\?/g
];

const CARD_CONTEXT_WORDS = new Set(["card", "cards", "cc", "credit", "creditcard", "creditcards"]);
const CARD_CONTEXT_COMPOUND_KEY = /^(credit|debit|payment|customer|stored|saved)?cards?$/;
const CARD_NUMBER_KEY = [/(card|cc)(number|num|no)$/, /^x?pan$/];
const SENSITIVE_KEY_ANYWHERE = [
  ...CARD_NUMBER_KEY,
  /(cvv2?|cvc2?|cv2|ccv|cvn|cvd)(value|code|number|no)?$/,
  /securitycode$/,
  /^x?(creditcard|card|cc)?(cid|csc)$/,
  /(card|cc)(code|verificationcode|verificationvalue|securityvalue)$/,
  /^x?avs|avs$|(card|cc)avs/,
  /^x?(encrypted)?(creditcard|card|cc)?exp(iry|iration)?(month|mon|year|yr|mm|yy|yyyy)$/,
  /^encrypted(card)?exp(iry|iration)?(date)?$/,
  /(card|cc)exp/,
  /^x?(track[12]?|track[12]?data|magstripe|magstripedata|magneticstripe)$/
];
// btrz-api-sales order payments send the card security value as `authorization` next to `ccnumber`.
const SENSITIVE_KEY_IN_CARD_CONTEXT =
  /^(number|num|no|month|mon|year|yr|mm|yy|yyyy|code|authorization|verificationcode|verificationvalue|securityvalue)$|^exp/;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function keyWords(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function isCardContextKey(key) {
  return keyWords(key).some((word) => CARD_CONTEXT_WORDS.has(word)) ||
    CARD_CONTEXT_COMPOUND_KEY.test(normalizeKey(key));
}

function isSensitiveKey(key, inCardContext) {
  const normalized = normalizeKey(key);
  if (!normalized) {
    return false;
  }
  if (SENSITIVE_KEY_ANYWHERE.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return inCardContext && SENSITIVE_KEY_IN_CARD_CONTEXT.test(normalized);
}

function isSensitiveKeyPath(segments, inTopLevelCardContext) {
  let inCardContext = inTopLevelCardContext;
  for (const segment of segments) {
    if (isSensitiveKey(segment, inCardContext)) {
      return true;
    }
    inCardContext = inCardContext || isCardContextKey(segment);
  }
  return false;
}

function maskAll(text) {
  return MASK_CHAR.repeat(text.length);
}

function passesLuhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumberShape(digits) {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  return /^[2-6]/.test(digits) && (digits.length !== 13 || digits[0] === "4");
}

function looksLikeCardNumber(digits) {
  return hasCardNumberShape(digits) && passesLuhn(digits);
}

function maskCardNumbersInString(text) {
  let masked = text;
  for (const pattern of TRACK_DATA) {
    masked = masked.replace(pattern, maskAll);
  }
  return masked.replace(CARD_NUMBER_CANDIDATE, (match) => {
    if (!looksLikeCardNumber(match.replace(URL_ENCODED_SEPARATOR, "").replace(/\D/g, ""))) {
      return match;
    }
    return match.replace(/(%20|%2[bBdD])|\d/g, (char, separator) => separator || MASK_CHAR);
  });
}

function decodeQueryComponent(component) {
  try {
    return decodeURIComponent(component.replace(/\+/g, " "));
  } catch (_err) {
    return component;
  }
}

function maskQueryPairs(query) {
  const pairs = query.split("&").map((pair) => {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) {
      return {pair};
    }
    const rawKey = pair.slice(0, eqIndex);
    const rawValue = pair.slice(eqIndex + 1);
    return {
      pair,
      rawKey,
      rawValue,
      segments: decodeQueryComponent(rawKey).split(/[[\].]+/).filter(Boolean),
      value: decodeQueryComponent(rawValue)
    };
  });
  const fields = {};
  for (const {segments, value} of pairs) {
    if (segments && segments.length === 1) {
      fields[segments[0]] = value;
    }
  }
  const inCardContext = holdsCardNumber(fields);

  return pairs.map(({pair, rawKey, rawValue, segments}) => {
    if (!segments || !isSensitiveKeyPath(segments, inCardContext)) {
      return pair;
    }
    return `${rawKey}=${maskAll(rawValue)}`;
  }).join("&");
}

function sanitizeJsonText(text, depth) {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_err) {
    return null;
  }
  const sanitized = JSON.stringify(sanitizeNode(parsed, false, depth + 1));
  return sanitized === JSON.stringify(parsed) ? text : sanitized;
}

function sanitizeString(text, depth) {
  const sanitizedJson = sanitizeJsonText(text, depth);
  if (sanitizedJson !== null) {
    return sanitizedJson;
  }
  let masked = text;
  if (masked.includes("=")) {
    const queryStart = masked.indexOf("?");
    masked = queryStart === -1
      ? maskQueryPairs(masked)
      : `${masked.slice(0, queryStart + 1)}${maskQueryPairs(masked.slice(queryStart + 1))}`;
  }
  return maskCardNumbersInString(masked);
}

function sanitizeNumber(value, inCardContext) {
  const text = String(value);
  if (inCardContext && Number.isInteger(value) && !Number.isSafeInteger(value) && hasCardNumberShape(text)) {
    return maskAll(text);
  }
  const masked = maskCardNumbersInString(text);
  return masked === text ? value : masked;
}

function maskLeaves(value, depth = 0) {
  if (depth > MAX_DEPTH) {
    return TRUNCATED;
  }
  if (typeof value === "string") {
    return maskAll(value);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return maskAll(String(value));
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskLeaves(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const masked = {};
    for (const key of Object.keys(value)) {
      masked[key] = maskLeaves(value[key], depth + 1);
    }
    return masked;
  }
  return value;
}

function sanitizeNode(value, inCardContext, depth) {
  if (depth > MAX_DEPTH) {
    return TRUNCATED;
  }
  if (typeof value === "string") {
    return sanitizeString(value, depth);
  }
  if (typeof value === "number") {
    return sanitizeNumber(value, inCardContext);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNode(item, inCardContext, depth + 1));
  }
  if (value && typeof value === "object") {
    const objectInCardContext = inCardContext || holdsCardNumber(value);
    const sanitized = {};
    for (const key of Object.keys(value)) {
      sanitized[key] = isSensitiveKey(key, objectInCardContext)
        ? maskLeaves(value[key], depth + 1)
        : sanitizeNode(value[key], objectInCardContext || isCardContextKey(key), depth + 1);
    }
    return sanitized;
  }
  return value;
}

function holdsCardNumber(object) {
  return Object.keys(object).some((key) => {
    const field = object[key];
    if (CARD_NUMBER_KEY.some((pattern) => pattern.test(normalizeKey(key))) && field !== null && field !== "") {
      return true;
    }
    if (typeof field === "number") {
      return sanitizeNumber(field, false) !== field;
    }
    return typeof field === "string" && maskCardNumbersInString(field) !== field;
  });
}

/**
 * Masks credit card data (card numbers, expiration dates, CVV/CVC, AVS codes and track data) with "x".
 * Fields are matched by name; card numbers and track data are also detected by content.
 * Subtrees nested deeper than MAX_DEPTH are replaced with "[TRUNCATED]".
 * Returns a new value; the input is not mutated.
 */
function sanitizeValue(value) {
  return sanitizeNode(value, false, 0);
}

function sanitizeRecord(record) {
  const sanitized = Object.assign({}, record);
  for (const field of ["url", "path", "query", "headers", "body"]) {
    if (Object.prototype.hasOwnProperty.call(sanitized, field)) {
      sanitized[field] = sanitizeValue(sanitized[field]);
    }
  }
  return sanitized;
}

module.exports = {sanitizeRecord, sanitizeValue, maskCardNumbersInString};
