"use strict";
const process = require("process");
const morgan = require("morgan");

module.exports = function _default(app, stream, name, options = {}) {
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
  morgan.format("combined-log", `[${name}-res] serverId=":serverId" remoteaddr=":remote-addr" xapikey=":req[x-api-key]" responsetime=:response-time[1] date=":date[iso]" traceId=":traceId" method=:method url=":url" http=:http-version status=:status responselength=:res[content-length] referrer=":referrer" useragent=":user-agent"`);

  if (options.request) {
    app.use(morgan("request-log", {
      stream,
      immediate: true
    }));
  }

  if (options.response) {
    app.use(morgan("combined-log", {
      stream
    }));
  }
};
