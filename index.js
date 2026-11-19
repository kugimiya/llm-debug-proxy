import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";

const LISTEN_HOST = process.env.LISTEN_HOST ?? "0.0.0.0";
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? "1234");
const TARGET_HOST = process.env.TARGET_HOST ?? "127.0.0.1";
const TARGET_PORT = Number(process.env.TARGET_PORT ?? "1235");
const LOG_DIR = path.resolve(process.env.LOG_DIR ?? "logs");

/** Pathnames (no query) proxied without creating a log directory. */
const SKIP_LOG_PATHS = new Set(
  (process.env.SKIP_LOG_PATHS ?? "/api/v1/models")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean),
);

/** One upstream socket per request — avoids garbled POST bodies when OpenCode fires parallel calls. */
const upstreamAgent = new http.Agent({ keepAlive: false });

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
]);

function tsFolder() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function forwardRequestHeaders(incoming, bodyLength) {
  const headers = { ...incoming };
  for (const h of HOP_BY_HOP) delete headers[h];
  delete headers["accept-encoding"];
  headers.host = `${TARGET_HOST}:${TARGET_PORT}`;
  headers.connection = "close";
  if (bodyLength > 0) {
    headers["content-length"] = String(bodyLength);
  } else {
    delete headers["content-length"];
  }
  return headers;
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function bodyFileName(contentType) {
  if (!contentType) return "body.bin";
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return "body.json";
  if (ct.includes("text") || ct.includes("event-stream")) return "body.txt";
  return "body.bin";
}

function readIncomingBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function appendToolCallDelta(toolCallsByIndex, deltas) {
  for (const tc of deltas ?? []) {
    const idx = tc.index ?? 0;
    const acc = toolCallsByIndex.get(idx) ?? {
      id: "",
      name: "",
      arguments: "",
    };
    if (tc.id) acc.id = tc.id;
    if (tc.function?.name) acc.name += tc.function.name;
    if (tc.function?.arguments) acc.arguments += tc.function.arguments;
    toolCallsByIndex.set(idx, acc);
  }
}

function createSseAggregator() {
  let lineBuf = "";
  let role = null;
  let content = "";
  let reasoning = "";
  const toolCallsByIndex = new Map();
  let finishReason = null;
  let usage = null;
  let model = null;
  let completionId = null;
  const parseErrors = [];

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const evt = JSON.parse(payload);
      if (evt.model) model = evt.model;
      if (evt.id) completionId = evt.id;
      if (evt.usage) usage = evt.usage;
      for (const choice of evt.choices ?? []) {
        const delta = choice.delta ?? {};
        if (delta.role) role = delta.role;
        if (typeof delta.content === "string") content += delta.content;
        if (typeof delta.reasoning_content === "string") {
          reasoning += delta.reasoning_content;
        }
        appendToolCallDelta(toolCallsByIndex, delta.tool_calls);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      parseErrors.push({
        error: err.message,
        preview: payload.slice(0, 240),
      });
    }
  };

  return {
    feed(chunk) {
      lineBuf += chunk.toString("utf8");
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    },
    finish() {
      if (lineBuf.trim()) processLine(lineBuf);
      return {
        role,
        content,
        reasoning,
        toolCalls: [...toolCallsByIndex.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, tc]) => ({ index, ...tc })),
        finishReason,
        usage,
        model,
        completionId,
        parseErrors,
      };
    },
  };
}

function writeParsedSseResponse(parsedPath, parsed) {
  const lines = ["# SSE response (parsed)", ""];
  if (parsed.completionId) lines.push(`id: ${parsed.completionId}`);
  if (parsed.model) lines.push(`model: ${parsed.model}`);
  if (parsed.role) lines.push(`role: ${parsed.role}`);
  if (parsed.finishReason) lines.push(`finish_reason: ${parsed.finishReason}`);
  lines.push("");

  lines.push("--- content ---");
  lines.push(parsed.content || "(empty)");
  lines.push("");

  if (parsed.reasoning) {
    lines.push("--- reasoning ---");
    lines.push(parsed.reasoning);
    lines.push("");
  }

  if (parsed.toolCalls.length) {
    lines.push("--- tool_calls ---");
    for (const tc of parsed.toolCalls) {
      lines.push(`[${tc.index}] id=${tc.id || "?"}`);
      lines.push(`name: ${tc.name || "(partial)"}`);
      lines.push(`arguments: ${tc.arguments || ""}`);
      lines.push("");
    }
  }

  if (parsed.usage) {
    lines.push("--- usage ---");
    lines.push(JSON.stringify(parsed.usage, null, 2));
    lines.push("");
  }

  if (parsed.parseErrors.length) {
    lines.push("--- parse_errors ---");
    for (const e of parsed.parseErrors) {
      lines.push(`${e.error}: ${e.preview}`);
    }
    lines.push("");
  }

  fs.writeFileSync(parsedPath, `${lines.join("\n")}\n`, "utf8");
}

function createTapStream(logPath, { parseSse = false, parsedPath } = {}) {
  const logStream = fs.createWriteStream(logPath);
  const sse = parseSse ? createSseAggregator() : null;
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      sse?.feed(chunk);
      if (!logStream.write(chunk)) {
        logStream.once("drain", () => cb(null, chunk));
      } else {
        cb(null, chunk);
      }
    },
    flush(cb) {
      logStream.end(() => {
        if (sse && parsedPath) {
          try {
            writeParsedSseResponse(parsedPath, sse.finish());
          } catch {
            /* parsing must not break the proxied stream */
          }
        }
        cb();
      });
    },
  });
  logStream.on("error", () => {
    /* logging must not break the proxied stream */
  });
  return { tap, getBytes: () => bytes };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function requestPath(url) {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function shouldCapture(url) {
  return !SKIP_LOG_PATHS.has(requestPath(url));
}

function forwardUpstream(clientReq, clientRes, body) {
  const upstreamHeaders = forwardRequestHeaders(
    clientReq.headers,
    body.length,
  );

  const upstreamReq = http.request(
    {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers: upstreamHeaders,
      agent: upstreamAgent,
    },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      for (const h of HOP_BY_HOP) delete responseHeaders[h];
      clientRes.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(clientRes);
      upstreamRes.on("error", (err) => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "content-type": "application/json" });
        }
        clientRes.end(
          JSON.stringify({ error: "Bad Gateway", detail: err.message }),
        );
      });
    },
  );

  upstreamReq.on("error", (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
    }
    clientRes.end(
      JSON.stringify({ error: "Bad Gateway", detail: err.message }),
    );
  });

  if (body.length) upstreamReq.write(body);
  upstreamReq.end();
}

function handleRequestPassthrough(clientReq, clientRes) {
  readIncomingBody(clientReq)
    .then((body) => forwardUpstream(clientReq, clientRes, body))
    .catch((err) => {
      clientRes.writeHead(400, { "content-type": "application/json" });
      clientRes.end(
        JSON.stringify({ error: "Bad Request", detail: err.message }),
      );
    });
}

function handleRequest(clientReq, clientRes) {
  if (!shouldCapture(clientReq.url)) {
    handleRequestPassthrough(clientReq, clientRes);
    return;
  }
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const exchangeDir = path.join(LOG_DIR, `${tsFolder()}_${id.slice(0, 8)}`);
  ensureDir(exchangeDir);

  const clientMeta = {
    id,
    startedAt,
    direction: "client -> proxy",
    method: clientReq.method,
    url: clientReq.url,
    httpVersion: clientReq.httpVersion,
    remoteAddress: clientReq.socket?.remoteAddress,
    remotePort: clientReq.socket?.remotePort,
  };
  writeJson(path.join(exchangeDir, "00-client-meta.json"), clientMeta);
  writeJson(
    path.join(exchangeDir, "01-request-headers.json"),
    sanitizeHeaders(clientReq.headers),
  );

  readIncomingBody(clientReq)
    .then((body) => {
      const reqContentType = clientReq.headers["content-type"] ?? "";
      const reqBodyPath = path.join(
        exchangeDir,
        `02-request-${bodyFileName(reqContentType)}`,
      );
      if (body.length) fs.writeFileSync(reqBodyPath, body);

      const headerLen = Number(clientReq.headers["content-length"]);
      if (
        Number.isFinite(headerLen) &&
        headerLen >= 0 &&
        headerLen !== body.length
      ) {
        writeJson(path.join(exchangeDir, "warn-body-length-mismatch.json"), {
          contentLengthHeader: headerLen,
          bytesRead: body.length,
        });
        console.warn(
          `[${id.slice(0, 8)}] content-length ${headerLen} but read ${body.length} bytes`,
        );
      }

      writeJson(path.join(exchangeDir, "03-upstream-meta.json"), {
        id,
        target: `http://${TARGET_HOST}:${TARGET_PORT}${clientReq.url}`,
        method: clientReq.method,
        requestBodyBytes: body.length,
      });

      const upstreamHeaders = forwardRequestHeaders(
        clientReq.headers,
        body.length,
      );

      const upstreamReq = http.request(
        {
          hostname: TARGET_HOST,
          port: TARGET_PORT,
          path: clientReq.url,
          method: clientReq.method,
          headers: upstreamHeaders,
          agent: upstreamAgent,
        },
        (upstreamRes) => {
          writeJson(
            path.join(exchangeDir, "04-response-headers.json"),
            sanitizeHeaders(upstreamRes.headers),
          );

          const resContentType = upstreamRes.headers["content-type"] ?? "";
          const isEventStream = resContentType
            .toLowerCase()
            .includes("event-stream");
          const resBodyPath = path.join(
            exchangeDir,
            `05-response-${bodyFileName(resContentType)}`,
          );
          const parsedSsePath = isEventStream
            ? path.join(exchangeDir, "05-response-body-parsed.txt")
            : undefined;
          const { tap, getBytes } = createTapStream(resBodyPath, {
            parseSse: isEventStream,
            parsedPath: parsedSsePath,
          });

          const responseHeaders = { ...upstreamRes.headers };
          for (const h of HOP_BY_HOP) delete responseHeaders[h];

          clientRes.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          upstreamRes.pipe(tap).pipe(clientRes);

          let logged = false;
          const finishLog = (extra = {}) => {
            if (logged) return;
            logged = true;
            writeJson(path.join(exchangeDir, "06-summary.json"), {
              id,
              startedAt,
              finishedAt: new Date().toISOString(),
              statusCode: upstreamRes.statusCode,
              responseBodyBytes: getBytes(),
              ...extra,
            });
            console.log(
              `[${id.slice(0, 8)}] ${clientReq.method} ${clientReq.url} -> ${upstreamRes.statusCode} (${getBytes()} B resp) -> ${exchangeDir}`,
            );
          };

          clientRes.on("finish", () => finishLog({ clientClosed: false }));
          clientRes.on("close", () => {
            if (!clientRes.writableFinished) finishLog({ clientClosed: true });
          });
          upstreamRes.on("error", (err) => {
            writeJson(path.join(exchangeDir, "error-upstream-response.json"), {
              message: err.message,
              stack: err.stack,
            });
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { "content-type": "application/json" });
            }
            clientRes.end(
              JSON.stringify({ error: "Bad Gateway", detail: err.message }),
            );
          });
        },
      );

      upstreamReq.on("error", (err) => {
        writeJson(path.join(exchangeDir, "error-upstream-request.json"), {
          message: err.message,
          stack: err.stack,
        });
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "content-type": "application/json" });
        }
        clientRes.end(
          JSON.stringify({ error: "Bad Gateway", detail: err.message }),
        );
        console.error(`[${id.slice(0, 8)}] upstream error:`, err.message);
      });

      if (body.length) upstreamReq.write(body);
      upstreamReq.end();
    })
    .catch((err) => {
      writeJson(path.join(exchangeDir, "error-read-body.json"), {
        message: err.message,
        stack: err.stack,
      });
      clientRes.writeHead(400, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "Bad Request", detail: err.message }));
    });
}

ensureDir(LOG_DIR);

const server = http.createServer(handleRequest);

if (
  TARGET_HOST === LISTEN_HOST &&
  TARGET_PORT === LISTEN_PORT
) {
  console.error(
    "Refusing to start: TARGET_PORT equals LISTEN_PORT (proxy loop).",
  );
  process.exit(1);
}

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `LM Studio API catcher listening on http://${LISTEN_HOST}:${LISTEN_PORT}`,
  );
  console.log(`Forwarding to http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`Writing captures to ${LOG_DIR}`);
  if (SKIP_LOG_PATHS.size) {
    console.log(`Passthrough (no logs): ${[...SKIP_LOG_PATHS].join(", ")}`);
  }
  if (LISTEN_PORT === 1234 && TARGET_PORT === 1235) {
    console.log(
      "Hint: OpenCode points at :1234, LM Studio on :1235 — stop any old catcher still bound to :1235.",
    );
  }
});