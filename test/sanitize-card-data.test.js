"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {sanitizeRecord, sanitizeValue, maskCardNumbersInString} = require("../src/sanitize-card-data");

const VISA = "4111111111111111";
const AMEX = "378282246310005";
const MASTERCARD = "5555555555554444";

test("masks card numbers found anywhere in a string with x", () => {
  assert.equal(maskCardNumbersInString(`paid with ${VISA} today`), "paid with xxxxxxxxxxxxxxxx today");
  assert.equal(maskCardNumbersInString(AMEX), "xxxxxxxxxxxxxxx");
  assert.equal(maskCardNumbersInString(MASTERCARD), "xxxxxxxxxxxxxxxx");
});

test("masks card numbers written with spaces or dashes and keeps the separators", () => {
  assert.equal(maskCardNumbersInString("4111 1111 1111 1111"), "xxxx xxxx xxxx xxxx");
  assert.equal(maskCardNumbersInString("4111-1111-1111-1111"), "xxxx-xxxx-xxxx-xxxx");
});

test("does not mask digit runs that fail the Luhn check", () => {
  assert.equal(maskCardNumbersInString("4111111111111112"), "4111111111111112");
});

test("does not mask millisecond timestamps, short numbers or digits inside ids", () => {
  assert.equal(maskCardNumbersInString("1786417200000"), "1786417200000");
  assert.equal(maskCardNumbersInString("1786417200006"), "1786417200006");
  assert.equal(maskCardNumbersInString("12345"), "12345");
  assert.equal(maskCardNumbersInString(`5f${VISA}ab`), `5f${VISA}ab`);
});

test("masks card numbers in URLs, paths and query strings", () => {
  assert.equal(
    maskCardNumbersInString(`/v1/cards/${VISA}?foo=1`),
    "/v1/cards/xxxxxxxxxxxxxxxx?foo=1"
  );
});

test("masks card number fields by name regardless of value format", () => {
  const out = sanitizeValue({
    cardNumber: "4111 1111",
    ccNumber: 1234,
    creditCardNumber: VISA,
    card_no: "999",
    pan: "123456",
    other: "keep"
  });
  assert.deepEqual(out, {
    cardNumber: "xxxxxxxxx",
    ccNumber: "xxxx",
    creditCardNumber: "xxxxxxxxxxxxxxxx",
    card_no: "xxx",
    pan: "xxxxxx",
    other: "keep"
  });
});

test("masks CVV, CVC and security code fields by name", () => {
  const out = sanitizeValue({
    cvv: "123",
    CVV2: 456,
    cvc: "7890",
    ccv: "111",
    securityCode: "222",
    cardCode: "333",
    "card-cvc": "444"
  });
  assert.deepEqual(out, {
    cvv: "xxx",
    CVV2: "xxx",
    cvc: "xxxx",
    ccv: "xxx",
    securityCode: "xxx",
    cardCode: "xxx",
    "card-cvc": "xxx"
  });
});

test("masks AVS fields by name", () => {
  const out = sanitizeValue({
    avs: "Y",
    avsCode: "N",
    avs_result: "Z",
    avsZip: "M5V 2T6"
  });
  assert.deepEqual(out, {
    avs: "x",
    avsCode: "x",
    avs_result: "x",
    avsZip: "xxxxxxx"
  });
});

test("masks expiration month and year fields by name", () => {
  const out = sanitizeValue({
    expMonth: "12",
    exp_year: 2027,
    expirationMonth: 1,
    expirationYear: "2030",
    expiryMonth: "03",
    ccExp: "12/27",
    cardExpiration: "2027-12",
    creditCardExpiryDate: "1227"
  });
  assert.deepEqual(out, {
    expMonth: "xx",
    exp_year: "xxxx",
    expirationMonth: "x",
    expirationYear: "xxxx",
    expiryMonth: "xx",
    ccExp: "xxxxx",
    cardExpiration: "xxxxxxx",
    creditCardExpiryDate: "xxxx"
  });
});

test("does not mask generic expiration or number fields outside a card object", () => {
  const out = sanitizeValue({
    expiration: "2027-01-01",
    expirationDate: "2027-01-01",
    number: "42",
    month: 5,
    year: 2026,
    code: "PROMO"
  });
  assert.deepEqual(out, {
    expiration: "2027-01-01",
    expirationDate: "2027-01-01",
    number: "42",
    month: 5,
    year: 2026,
    code: "PROMO"
  });
});

test("masks generic number, expiration and code fields inside a card object", () => {
  const out = sanitizeValue({
    payments: [{
      creditCard: {
        number: "4111",
        expiration: "12/27",
        expirationDate: "2027-12",
        exp: "1227",
        month: 12,
        year: 2027,
        code: "123",
        holderName: "Jane Doe",
        type: "visa"
      }
    }]
  });
  assert.deepEqual(out, {
    payments: [{
      creditCard: {
        number: "xxxx",
        expiration: "xxxxx",
        expirationDate: "xxxxxxx",
        exp: "xxxx",
        month: "xx",
        year: "xxxx",
        code: "xxx",
        holderName: "Jane Doe",
        type: "visa"
      }
    }]
  });
});

test("masks every leaf when a sensitive field holds an object or array", () => {
  const out = sanitizeValue({
    expMonth: {value: "12"},
    cvv: ["1", 2, null, true]
  });
  assert.deepEqual(out, {
    expMonth: {value: "xx"},
    cvv: ["x", "x", null, true]
  });
});

test("masks card numbers in free-text string and numeric values by content", () => {
  const out = sanitizeValue({
    note: `card ${VISA}`,
    raw: Number(VISA),
    items: [VISA],
    timestamp: 1786417200000
  });
  assert.deepEqual(out, {
    note: "card xxxxxxxxxxxxxxxx",
    raw: "xxxxxxxxxxxxxxxx",
    items: ["xxxxxxxxxxxxxxxx"],
    timestamp: 1786417200000
  });
});

test("leaves empty strings, null, booleans and non-card values unchanged", () => {
  const out = sanitizeValue({cvv: "", cardNumber: null, flag: true, n: 5, s: "hello"});
  assert.deepEqual(out, {cvv: "", cardNumber: null, flag: true, n: 5, s: "hello"});
});

test("sanitizeRecord masks url, path, query, headers and body", () => {
  const record = {
    ts: "2026-08-11T03:16:00.000Z",
    method: "POST",
    url: `/v1/pay/${VISA}?cardNumber=4012888888881881&cvv=123&exp_month=12&avs=Y&expirationDate=2027-01&foo=1`,
    path: `/v1/pay/${VISA}`,
    query: {cardNumber: "4012888888881881", cvv: "123", exp_month: "12", avs: "Y", expirationDate: "2027-01", foo: "1"},
    headers: {host: "example", "x-card-number": "4012", "x-note": `card ${VISA}`},
    body: {creditCard: {number: VISA, cvv: "123", expMonth: 12, expYear: 2027}, avsCode: "Y"},
    status: 201,
    durationMs: 42
  };

  assert.deepEqual(sanitizeRecord(record), {
    ts: "2026-08-11T03:16:00.000Z",
    method: "POST",
    url: "/v1/pay/xxxxxxxxxxxxxxxx?cardNumber=xxxxxxxxxxxxxxxx&cvv=xxx&exp_month=xx&avs=x&expirationDate=2027-01&foo=1",
    path: "/v1/pay/xxxxxxxxxxxxxxxx",
    query: {cardNumber: "xxxxxxxxxxxxxxxx", cvv: "xxx", exp_month: "xx", avs: "x", expirationDate: "2027-01", foo: "1"},
    headers: {host: "example", "x-card-number": "xxxx", "x-note": "card xxxxxxxxxxxxxxxx"},
    body: {creditCard: {number: "xxxxxxxxxxxxxxxx", cvv: "xxx", expMonth: "xx", expYear: "xxxx"}, avsCode: "x"},
    status: 201,
    durationMs: 42
  });
});

test("sanitizeRecord masks bracketed card fields in url query strings", () => {
  const record = {
    url: "/v1/pay?creditCard%5Bnumber%5D=4111&creditCard[cvv]=123&card.expiration=12%2F27",
    path: "/v1/pay",
    query: {},
    headers: {}
  };
  assert.equal(
    sanitizeRecord(record).url,
    "/v1/pay?creditCard%5Bnumber%5D=xxxx&creditCard[cvv]=xxx&card.expiration=xxxxxxx"
  );
});

test("sanitizeRecord masks string bodies including form-encoded card fields", () => {
  const out = sanitizeRecord({
    url: "/",
    path: "/",
    query: {},
    headers: {},
    body: `note=${VISA}&cvv=123&expMonth=12&avs=Y&name=Jane`
  });
  assert.equal(out.body, "note=xxxxxxxxxxxxxxxx&cvv=xxx&expMonth=xx&avs=x&name=Jane");
});

test("sanitizeRecord masks card fields in URLs carried by header values", () => {
  const out = sanitizeRecord({
    url: "/",
    path: "/",
    query: {},
    headers: {referer: "https://shop.example/pay?cvv=123&foo=1"}
  });
  assert.equal(out.headers.referer, "https://shop.example/pay?cvv=xxx&foo=1");
});

test("sanitizeRecord does not mutate the input record", () => {
  const record = {url: "/?cvv=1", path: "/", query: {cvv: "1"}, headers: {}, body: {cvv: "1"}};
  sanitizeRecord(record);
  assert.deepEqual(record, {url: "/?cvv=1", path: "/", query: {cvv: "1"}, headers: {}, body: {cvv: "1"}});
});
