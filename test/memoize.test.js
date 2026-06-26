const test = require("node:test");
const assert = require("node:assert/strict");

const memoize = require("../src/memoize");

test("memoize caches by first argument when no resolver is provided", () => {
  let calls = 0;
  const fn = memoize((value, suffix) => {
    calls += 1;
    return `${value}${suffix}`;
  });

  assert.equal(fn("a", "1"), "a1");
  assert.equal(fn("a", "2"), "a1");
  assert.equal(calls, 1);
});

test("memoize uses resolver output as cache key", () => {
  let calls = 0;
  const fn = memoize(
    (a, b) => {
      calls += 1;
      return `${a}:${b}`;
    },
    (_a, b) => b
  );

  assert.equal(fn("x", "1"), "x:1");
  assert.equal(fn("y", "1"), "x:1");
  assert.equal(calls, 1);
});

test("memoize exposes a mutable cache implementing map methods", () => {
  const fn = memoize((value) => `${value}-computed`);
  assert.equal(typeof fn.cache.get, "function");
  assert.equal(typeof fn.cache.set, "function");
  assert.equal(typeof fn.cache.has, "function");
  assert.equal(typeof fn.cache.delete, "function");

  fn.cache.set("k", "from-cache");
  assert.equal(fn("k"), "from-cache");
  assert.equal(fn.cache.has("k"), true);
  fn.cache.delete("k");
  assert.equal(fn("k"), "k-computed");
});

test("memoize throws when func or resolver are invalid", () => {
  assert.throws(() => memoize(null), new TypeError("Expected a function"));
  assert.throws(() => memoize(() => "ok", "bad"), new TypeError("Expected a function"));
});
