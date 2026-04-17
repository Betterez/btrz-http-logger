const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const moduleUnderTestPath = path.resolve(__dirname, "..", "index.js");

function createMorganMock() {
  const tokens = {};
  const formats = {};

  function morgan(formatName, options) {
    return {formatName, options};
  }

  morgan.token = (name, fn) => {
    tokens[name] = fn;
  };

  morgan.format = (name, fn) => {
    formats[name] = fn;
  };

  morgan.compile = (template) => {
    return () => template;
  };

  return {
    morgan,
    tokens,
    formats
  };
}

test("module loads with the installed chalk package", () => {
  delete require.cache[moduleUnderTestPath];
  assert.doesNotThrow(() => {
    require(moduleUnderTestPath);
  });
});

function createChalkMock() {
  class ChalkInstance {
    dim(value) {
      return `DIM(${value})`;
    }

    red(value) {
      return `RED(${value})`;
    }

    magenta(value) {
      return `MAGENTA(${value})`;
    }

    bold(value) {
      return `BOLD(${value})`;
    }
  }

  return {Instance: ChalkInstance};
}

function withMockedDependencies(mocks, callback) {
  const originalLoad = Module._load;

  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return callback();
  } finally {
    Module._load = originalLoad;
  }
}

function loadLoggerModule({
  traceId = null
} = {}) {
  const app = {
    useCalls: [],
    use(middleware) {
      this.useCalls.push(middleware);
    }
  };
  const stream = {write() {}};
  const morganMock = createMorganMock();
  const otlpTraceMock = {
    getActiveSpan() {
      if (!traceId) {
        return null;
      }

      return {
        spanContext() {
          return {traceId};
        }
      };
    }
  };

  delete require.cache[moduleUnderTestPath];

  const memoizeMock = (fn) => {
    const cache = new Map();
    return function memoized(...args) {
      const key = JSON.stringify(args);
      if (!cache.has(key)) {
        cache.set(key, fn(...args));
      }
      return cache.get(key);
    };
  };

  const loggerFactory = withMockedDependencies(
    {
      morgan: morganMock.morgan,
      "lodash.memoize": memoizeMock,
      chalk: createChalkMock(),
      "@opentelemetry/api": {trace: otlpTraceMock}
    },
    () => require(moduleUnderTestPath)
  );

  return {
    app,
    stream,
    morganMock,
    loggerFactory
  };
}

test("registers request and response middleware when enabled", () => {
  const {app, stream, loggerFactory} = loadLoggerModule();

  loggerFactory(app, stream, "svc", {request: true, response: true});

  assert.equal(app.useCalls.length, 2);
  assert.deepEqual(app.useCalls[0], {
    formatName: "request-log",
    options: {stream, immediate: true}
  });
  assert.deepEqual(app.useCalls[1], {
    formatName: "combined-log",
    options: {stream}
  });
});

test("serverId token prefers ec2 id then server id, fallback missing", () => {
  const {app, stream, morganMock, loggerFactory} = loadLoggerModule();

  loggerFactory(app, stream, "svc");

  const serverIdToken = morganMock.tokens.serverId;

  app.ec2Metadata = {instanceId: "ec2"};
  assert.equal(serverIdToken(), `ec2#${process.pid}`);

  delete app.ec2Metadata;
  app.server = {instanceId: "server"};
  assert.equal(serverIdToken(), `server#${process.pid}`);

  delete app.server;
  assert.equal(serverIdToken(), `missing#${process.pid}`);
});

test("trace tokens format amzn and grafana ids", () => {
  const {app, stream, morganMock, loggerFactory} = loadLoggerModule({
    traceId: "trace-123"
  });

  loggerFactory(app, stream, "svc");

  const traceIdToken = morganMock.tokens.traceId;
  const grafanaTraceIdToken = morganMock.tokens.grafanaTraceId;

  assert.equal(
    traceIdToken({headers: {"x-amzn-trace-id": "Root=1-abc"}}),
    "Root-1-abc"
  );
  assert.equal(traceIdToken({headers: {}}), "");
  assert.equal(grafanaTraceIdToken(), "trace-123");
});

test("uniqueDate token increments suffix for duplicate timestamps", () => {
  const {app, stream, morganMock, loggerFactory} = loadLoggerModule();
  const OriginalDate = global.Date;
  let callCount = 0;

  class FakeDate extends Date {
    toISOString() {
      callCount += 1;
      if (callCount <= 2) {
        return "2026-01-01T00:00:00.123Z";
      }

      return "2026-01-01T00:00:00.124Z";
    }
  }

  try {
    global.Date = FakeDate;
    loggerFactory(app, stream, "svc");
    const uniqueDateToken = morganMock.tokens.uniqueDate;

    assert.equal(uniqueDateToken(), "2026-01-01T00:00:00.123000000Z");
    assert.equal(uniqueDateToken(), "2026-01-01T00:00:00.123000001Z");
    assert.equal(uniqueDateToken(), "2026-01-01T00:00:00.124000000Z");
  } finally {
    global.Date = OriginalDate;
  }
});

test("request-log format uses dim style only when colorize is true", () => {
  const nonColor = loadLoggerModule();
  nonColor.loggerFactory(nonColor.app, nonColor.stream, "svc", {colorize: false});

  const plainOutput = nonColor.morganMock.formats["request-log"]({}, {}, {});
  assert.match(plainOutput, /^\[svc-req]/);
  assert.doesNotMatch(plainOutput, /^DIM\(/);

  const colorized = loadLoggerModule();
  colorized.loggerFactory(colorized.app, colorized.stream, "svc", {colorize: true});

  const colorOutput = colorized.morganMock.formats["request-log"]({}, {}, {});
  assert.match(colorOutput, /^DIM\(\[svc-req]/);
});

test("combined-log format colorizes status by response class", () => {
  const nonColor = loadLoggerModule();
  nonColor.loggerFactory(nonColor.app, nonColor.stream, "svc", {colorize: false});
  const plainCombined = nonColor.morganMock.formats["combined-log"]({}, {}, {statusCode: 503});
  assert.match(plainCombined, /status=:status/);
  assert.doesNotMatch(plainCombined, /RED\(|MAGENTA\(/);

  const colorized = loadLoggerModule();
  colorized.loggerFactory(colorized.app, colorized.stream, "svc", {colorize: true});
  const combinedFormatter = colorized.morganMock.formats["combined-log"];

  const redStatus = combinedFormatter({}, {}, {statusCode: 503});
  assert.match(redStatus, /RED\(status=BOLD\(:status\)\)/);

  const magentaStatus = combinedFormatter({}, {}, {statusCode: 404});
  assert.match(magentaStatus, /MAGENTA\(status=BOLD\(:status\)\)/);

  const plainStatus = combinedFormatter({}, {}, {statusCode: 200});
  assert.match(plainStatus, /status=:status/);
  assert.doesNotMatch(plainStatus, /RED\(|MAGENTA\(/);
});
