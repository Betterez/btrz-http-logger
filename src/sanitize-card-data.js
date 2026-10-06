"use strict";

const MASK_CHAR = "x";

const CARD_NUMBER_CANDIDATE = /(?<![0-9A-Za-z])\d(?:[ -]?\d){12,18}(?![0-9A-Za-z])/g;

const CARD_CONTEXT_KEY = /card|^cc|credit/;
const SENSITIVE_KEY_ANYWHERE = [
  /(card|cc)(number|num|no)$/,
  /^pan$/,
  /(cvv2?|cvc2?|ccv|cvn|securitycode)$/,
  /^(creditcard|card|cc)?(cid|csc)$/,
  /(card|cc)(code|verificationcode|verificationvalue)$/,
  /^avs|avs$|(card|cc)avs/,
  /exp(iry|iration)?(month|mon|year|yr|mm|yy|yyyy)$/,
  /(card|cc)exp/
];
const SENSITIVE_KEY_IN_CARD_CONTEXT = /^(number|num|no|month|mon|year|yr|mm|yy|yyyy|code)$|^exp/;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCardContextKey(key) {
  return CARD_CONTEXT_KEY.test(normalizeKey(key));
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

function isSensitiveKeyPath(segments) {
  let inCardContext = false;
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

function looksLikeCardNumber(digits) {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  if (!/^[2-6]/.test(digits) || (digits.length === 13 && digits[0] !== "4")) {
    return false;
  }
  return passesLuhn(digits);
}

function maskCardNumbersInString(text) {
  return text.replace(CARD_NUMBER_CANDIDATE, (match) => {
    if (!looksLikeCardNumber(match.replace(/\D/g, ""))) {
      return match;
    }
    return match.replace(/\d/g, MASK_CHAR);
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
  return query.split("&").map((pair) => {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) {
      return pair;
    }
    const rawKey = pair.slice(0, eqIndex);
    const rawValue = pair.slice(eqIndex + 1);
    const segments = decodeQueryComponent(rawKey).split(/[[\].]+/).filter(Boolean);
    if (!isSensitiveKeyPath(segments)) {
      return pair;
    }
    return `${rawKey}=${maskAll(rawValue)}`;
  }).join("&");
}

function sanitizeString(text) {
  let masked = text;
  if (masked.includes("=")) {
    const queryStart = masked.indexOf("?");
    masked = queryStart === -1
      ? maskQueryPairs(masked)
      : `${masked.slice(0, queryStart + 1)}${maskQueryPairs(masked.slice(queryStart + 1))}`;
  }
  return maskCardNumbersInString(masked);
}

function maskLeaves(value) {
  if (typeof value === "string") {
    return maskAll(value);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return maskAll(String(value));
  }
  if (Array.isArray(value)) {
    return value.map(maskLeaves);
  }
  if (value && typeof value === "object") {
    const masked = {};
    for (const key of Object.keys(value)) {
      masked[key] = maskLeaves(value[key]);
    }
    return masked;
  }
  return value;
}

function sanitizeNode(value, inCardContext) {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (typeof value === "number") {
    const text = String(value);
    const masked = maskCardNumbersInString(text);
    return masked === text ? value : masked;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNode(item, inCardContext));
  }
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const key of Object.keys(value)) {
      sanitized[key] = isSensitiveKey(key, inCardContext)
        ? maskLeaves(value[key])
        : sanitizeNode(value[key], inCardContext || isCardContextKey(key));
    }
    return sanitized;
  }
  return value;
}

/**
 * Masks credit card data (card numbers, expiration dates, CVV/CVC and AVS codes) with "x".
 * Fields are matched by name; card numbers are also detected by content (Luhn-valid 13–19 digits).
 * Returns a new value; the input is not mutated.
 */
function sanitizeValue(value) {
  return sanitizeNode(value, false);
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
