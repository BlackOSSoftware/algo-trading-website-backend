function normalizePath(pathname) {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function createRouter() {
  const routes = [];

  function addRoute(method, path, handler) {
    routes.push({
      method,
      path: normalizePath(path),
      handler,
    });
  }

  async function handle(req, res) {
    const parsedUrl = new URL(req.url, "http://localhost");
    req.parsedUrl = parsedUrl;

    const pathname = normalizePath(parsedUrl.pathname);
    const method = req.method ? req.method.toUpperCase() : "GET";

    for (const route of routes) {
      if (route.method === method && route.path === pathname) {
        await route.handler(req, res);
        return true;
      }
    }

    return false;
  }

  return {
    get: (path, handler) => addRoute("GET", path, handler),
    post: (path, handler) => addRoute("POST", path, handler),
    handle,
  };
}

module.exports = { createRouter };
