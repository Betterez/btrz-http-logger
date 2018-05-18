"use strict";
const morgan = require("morgan");

module.exports = function _default(app, stream, name) {
  morgan.token("instanceId", () => {
    if (app.ec2Metadata) {
      return app.ec2Metadata.instanceId || "missing";
    }
    return "missing";
  });
  morgan.token("traceId", (req) => {
    return (req.headers["x-amzn-trace-id"] || "").replace("=", "-");
  });

  morgan.format("request-log", `[${name}-req] serverId=":instanceId" remoteaddr=":remote-addr" xapikey=":req[x-api-key]" date=":date[iso]" traceId=":traceId" method=:method url=":url" http=:http-version referrer=":referrer" useragent=":user-agent"`);
  morgan.format("combined-log", `[${name}-res] serverId=":instanceId" remoteaddr=":remote-addr" xapikey=":req[x-api-key]" responsetime=:response-time[1] date=":date[iso]" traceId=":traceId" method=:method url=":url" http=:http-version status=:status responselength=:res[content-length] referrer=":referrer" useragent=":user-agent"`);

  app.use(morgan("request-log", {
    stream,
    immediate: true
  }));

  app.use(morgan("combined-log", {
    stream
  }));
};
