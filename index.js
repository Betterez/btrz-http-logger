"use strict";
const process = require("process");
const chalk = require("chalk");
const morgan = require("morgan");

const defaultColor = (...strings) => strings.join();

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

  morgan.format("request-log", `[${name}-req] serverId=":serverId" remoteaddr=":remote-addr" xapikey=":req[x-api-key]" date=":date[iso]" traceId=":traceId" method=:method url=":url" http=:http-version referrer=":referrer" useragent=":user-agent"`);

  const combinedLogFormattersByColor = {};
  morgan.format("combined-log", function (tokens, req, res) {
    let statusColor = "default";
    let statusColorFn = defaultColor;

    if (config.colorize) {
      if (res.statusCode >= 500) {
        statusColor = "red";
        statusColorFn = (label, statusCode) => chalk.red(`${label}${chalk.bold(statusCode)}`);
      } else if (res.statusCode >= 400) {
        statusColor = "magenta";
        statusColorFn = (label, statusCode) => chalk.magenta(`${label}${chalk.bold(statusCode)}`);
      }
    }

    if (!combinedLogFormattersByColor[statusColor]) {
      // Cache the formatter to avoid recompilation every time a log is emitted
      combinedLogFormattersByColor[statusColor] = morgan.compile(
        `[${name}-res] serverId=":serverId" remoteaddr=":remote-addr" xapikey=":req[x-api-key]" responsetime=:response-time[1] date=":date[iso]" traceId=":traceId" method=:method url=":url" http=:http-version ${statusColorFn("status=", ":status")} responselength=:res[content-length] referrer=":referrer" useragent=":user-agent"`
      );
    }

    return combinedLogFormattersByColor[statusColor](tokens, req, res);
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
