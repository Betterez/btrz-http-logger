"use strict";
const process = require("process");
const chalk = require("chalk");
const memoize = require("lodash.memoize");
const morgan = require("morgan");
const {trace: otlpTrace} = require("@opentelemetry/api");

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

  const getRequestLogFormatter = memoize((colorScheme) => {
    let colorFn;

    switch (colorScheme) {
      case colorSchemes.NO_COLOR:
        colorFn = (logFormatString) => logFormatString;
        break;
      case colorSchemes.DIM_TEXT:
        colorFn = (logFormatString) => chalk.dim(logFormatString);
        break;
      default:
        throw new Error(`Unknown color scheme ${colorScheme}`);
    }

    return morgan.compile(
      colorFn(`[${name}-req] serverId=":serverId" remoteaddr=":remote-addr" xapikey=":req[x-api-key]" date=":date[iso]" traceId=":traceId" grafanaTraceId=":grafanaTraceId" method=:method url=":url" http=:http-version referrer=":referrer" useragent=":user-agent"`)
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
        statusCodeColorFn = (label, statusCode) => chalk.red(`${label}${chalk.bold(statusCode)}`);
        break;
      case colorSchemes.MAGENTA_STATUS_CODE:
        statusCodeColorFn = (label, statusCode) => chalk.magenta(`${label}${chalk.bold(statusCode)}`);
        break;
      default:
        throw new Error(`Unknown color scheme ${colorScheme}`);
    }

    return morgan.compile(
      `[${name}-res] serverId=":serverId" remoteaddr=":remote-addr" xapikey=":req[x-api-key]" responsetime=:response-time[1] date=":date[iso]" traceId=":traceId" grafanaTraceId=":grafanaTraceId" method=:method url=":url" http=:http-version ${statusCodeColorFn("status=", ":status")} responselength=:res[content-length] referrer=":referrer" useragent=":user-agent"`
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
    app.use(morgan("combined-log", {
      stream
    }));
  }
};
