const jwt = require("jsonwebtoken");
const { createHttpError } = require("../utils/httpError");

function getToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return null;
}

function authenticate(req) {
  const token = getToken(req);
  if (!token) {
    throw createHttpError(401, "Unauthorized");
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
  } catch (err) {
    throw createHttpError(401, "Unauthorized");
  }
}

function requireAuth(handler) {
  return async (req, res) => {
    authenticate(req);
    return handler(req, res);
  };
}

function requireAdmin(handler) {
  return async (req, res) => {
    authenticate(req);
    if (req.user?.role !== "admin") {
      throw createHttpError(403, "Forbidden");
    }
    return handler(req, res);
  };
}

module.exports = { requireAuth, requireAdmin };
