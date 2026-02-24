function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { createHttpError };
