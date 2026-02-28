const querystring = require("querystring");
const { createHttpError } = require("./httpError");

const MAX_BODY_SIZE = 1_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = "";
    let done = false;

    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;

      if (size > MAX_BODY_SIZE) {
        done = true;
        req.destroy();
        reject(createHttpError(413, "Payload too large"));
        return;
      }

      data += chunk;
    });

    req.on("end", () => {
      if (!done) resolve(data);
    });

    req.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}

async function parseBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};

  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw createHttpError(400, "Invalid JSON body");
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return querystring.parse(raw);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    return { raw };
  }
}

module.exports = { parseBody, readBody };
