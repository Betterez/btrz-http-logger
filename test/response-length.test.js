const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {countResponseBytes, responseLength} = require("../src/response-length");

async function serve(respond, requestFn = defaultRequest) {
  let loggedLength = null;
  let closed = null;

  const server = http.createServer((req, res) => {
    closed = new Promise((resolve) => {
      res.on("close", () => {
        loggedLength = responseLength(req, res);
        resolve();
      });
    });
    countResponseBytes(req, res, () => {
      respond(req, res);
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const clientResult = await requestFn(server.address().port);
    await closed;
    return {loggedLength, clientResult};
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

function defaultRequest(port) {
  return new Promise((resolve, reject) => {
    http.get({host: "127.0.0.1", port}, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({headers: res.headers, body: Buffer.concat(chunks)});
      });
    }).on("error", reject);
  });
}

test("responseLength uses the Content-Length header when it is set", async () => {
  const {loggedLength, clientResult} = await serve((req, res) => {
    res.setHeader("Content-Length", "5");
    res.end("hello");
  });

  assert.equal(clientResult.headers["content-length"], "5");
  assert.equal(loggedLength, "5");
});

test("responseLength counts body bytes of a chunked response without Content-Length", async () => {
  const {loggedLength, clientResult} = await serve((req, res) => {
    res.write("[");
    res.write("\"é\"");
    res.write(Buffer.from(",\"x\""));
    res.end("]");
  });

  assert.equal(clientResult.headers["transfer-encoding"], "chunked");
  assert.equal(clientResult.headers["content-length"], undefined);
  assert.equal(loggedLength, String(clientResult.body.length));
  assert.equal(loggedLength, "10");
});

test("responseLength honours the encoding passed to write and end", async () => {
  const {loggedLength, clientResult} = await serve((req, res) => {
    res.write("68656c6c6f", "hex");
    res.end("IQ==", "base64");
  });

  assert.equal(clientResult.body.toString(), "hello!");
  assert.equal(loggedLength, "6");
});

test("responseLength reports the bytes written before a stream is aborted", async () => {
  const {loggedLength} = await serve((req, res) => {
    res.write("partial", () => {
      res.destroy();
    });
  }, (port) => {
    return new Promise((resolve) => {
      http.get({host: "127.0.0.1", port}, (res) => {
        res.on("data", () => {});
        res.on("error", () => {});
        res.on("close", resolve);
      }).on("error", resolve);
    });
  });

  assert.equal(loggedLength, "7");
});

test("responseLength is undefined when no headers were sent", async () => {
  const {loggedLength} = await serve((req, res) => {
    res.destroy();
  }, (port) => {
    return new Promise((resolve) => {
      http.get({host: "127.0.0.1", port}, resolve).on("error", resolve);
    });
  });

  assert.equal(loggedLength, undefined);
});

test("countResponseBytes preserves write and end return values and callbacks", async () => {
  const results = {};
  await serve((req, res) => {
    results.writeReturn = res.write("a", () => {
      results.writeCallback = true;
    });
    results.endReturn = res.end(() => {
      results.endCallback = true;
    });
  });

  assert.equal(results.writeReturn, true);
  assert.equal(results.endReturn.constructor.name, "ServerResponse");
  assert.equal(results.writeCallback, true);
  assert.equal(results.endCallback, true);
});

test("responseLength is undefined when countResponseBytes was not applied and there is no Content-Length", () => {
  const res = {
    headersSent: true,
    getHeader() {
      return undefined;
    }
  };

  assert.equal(responseLength({}, res), undefined);
});
