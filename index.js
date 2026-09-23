"use strict";
const process = require("process");
const memoize = require("./src/memoize");
const {countResponseBytes, responseLength} = require("./src/response-length");
const morgan = require("morgan");
const {trace: otlpTrace} = require("@opentelemetry/api");

const ansi = {
  wrap(text, openCode, closeCode) {
    return `\u001b[${openCode}m${text}\u001b[${closeCode}m`;
  },
  dim(text) {
    return this.wrap(text, 2, 22);
  },
  bold(text) {
    return this.wrap(text, 1, 22);
  },
  red(text) {
    return this.wrap(text, 31, 39);
  },
  magenta(text) {
    return this.wrap(text, 35, 39);
  }
};

const colorSchemes = {
  NO_COLOR: "NO_COLOR",
  DIM_TEXT: "DIM_TEXT",
  RED_STATUS_CODE: "RED_STATUS_CODE",
  MAGENTA_STATUS_CODE: "MAGENTA_STATUS_CODE"
}

module.exports = function _default(app, stream, name, config = {}) {

  morgan.token("serverId", () => {
    const ec2Instance = app.ec2Metadata && app.ec2Metadata.instanceId;
    const serverInstance = app.server && app.server.instanceId;
    const instanceId = ec2Instance || serverInstance || "missing";
    const processId = `#${process.pid}`;

    return `${instanceId}${processId}`;
  });

  morgan.token("traceId", (req) => {
    return (req.headers["x-amzn-trace-id"] || "").replace("=", "-");
  });

  morgan.token("grafanaTraceId", () => {
    return otlpTrace.getActiveSpan()?.spanContext().traceId || "-";
  });

  morgan.token("responseLength", responseLength);

  let _dateOfPreviousLogLine = null;
  let _numberOfOtherLogsUsingThisDate = 0;

  /* Some logging systems will de-duplicate log lines which have exactly the same content and timestamp (date).
   * We don't want any of our logs to be de-duplicated, because we would effectively lose those logs.  To prevent
   * de-duplication, when there are multiple log lines emitted within the same millisecond window, we add a fake number
   * of nanoseconds to the timestamp of each log line.  This ensures that each log line has a unique timestamp,
   * preventing de-duplication.
   */
  morgan.token("uniqueDate", () => {
    const date = new Date().toISOString();

    if (_dateOfPreviousLogLine === date) {
      _numberOfOtherLogsUsingThisDate++;
    } else {
      _numberOfOtherLogsUsingThisDate = 0;
    }

    _dateOfPreviousLogLine = date;
    return `${date.slice(0, -1)}${_numberOfOtherLogsUsingThisDate.toString().padStart(6, "0")}Z`;
  });

  const getRequestLogFormatter = memoize((colorScheme) => {
    let colorFn;

    switch (colorScheme) {
      case colorSchemes.NO_COLOR:
        colorFn = (logFormatString) => logFormatString;
        break;
      case colorSchemes.DIM_TEXT:
        colorFn = (logFormatString) => ansi.dim(logFormatString);
        break;
      default:
        throw new Error(`Unknown color scheme ${colorScheme}`);
    }

    return morgan.compile(
      colorFn(`[${name}-req] server_id=":serverId" remoteaddr=":remote-addr" xapikey=":req[x-api-key]" date=":uniqueDate" amzn_trace_id=":traceId" grafana_trace_id=":grafanaTraceId" method=:method url=":url" http=:http-version referrer=":referrer" useragent=":user-agent"`)
    );
  });

  morgan.format("request-log", function (tokens, req, res) {
    let formatterFn = getRequestLogFormatter(colorSchemes.NO_COLOR);

    if (config.colorize) {
      formatterFn = getRequestLogFormatter(colorSchemes.DIM_TEXT);
    }

    return formatterFn(tokens, req, res);
  });

  const getCombinedLogFormatter = memoize((colorScheme) => {
    let statusCodeColorFn;

    switch (colorScheme) {
      case colorSchemes.NO_COLOR:
        statusCodeColorFn = (label, statusCode) => `${label}${statusCode}`;
        break;
      case colorSchemes.RED_STATUS_CODE:
        statusCodeColorFn = (label, statusCode) => ansi.red(`${label}${ansi.bold(statusCode)}`);
        break;
      case colorSchemes.MAGENTA_STATUS_CODE:
        statusCodeColorFn = (label, statusCode) => ansi.magenta(`${label}${ansi.bold(statusCode)}`);
        break;
      default:
        throw new Error(`Unknown color scheme ${colorScheme}`);
    }

    return morgan.compile(
      `[${name}-res] server_id=":serverId" remoteaddr=":remote-addr" xapikey=":req[x-api-key]" responsetime=:response-time[1] date=":uniqueDate" amzn_trace_id=":traceId" grafana_trace_id=":grafanaTraceId" method=:method url=":url" http=:http-version ${statusCodeColorFn("status=", ":status")} responselength=:responseLength referrer=":referrer" useragent=":user-agent"`
    );
  });

  morgan.format("combined-log", function (tokens, req, res) {
    let formatterFn = getCombinedLogFormatter(colorSchemes.NO_COLOR);

    if (config.colorize) {
      if (res.statusCode >= 500) {
        formatterFn = getCombinedLogFormatter(colorSchemes.RED_STATUS_CODE);
      } else if (res.statusCode >= 400) {
        formatterFn = getCombinedLogFormatter(colorSchemes.MAGENTA_STATUS_CODE);
      }
    }

    return formatterFn(tokens, req, res);
  });

  if (config.request) {
    app.use(morgan("request-log", {
      stream,
      immediate: true
    }));
  }

  if (config.response) {
    app.use(countResponseBytes);
    app.use(morgan("combined-log", {
      stream
    }));
  }
};

module.exports.s3RequestRecorder = require("./src/s3-request-recorder").s3RequestRecorder;
