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
    const normalized = normalizePath(path);
    const segments = normalized.split("/").filter(Boolean);
    routes.push({
      method,
      path: normalized,
      segments,
      handler,
    });
  }

  async function handle(req, res) {
    const parsedUrl = new URL(req.url, "http://localhost");
    req.parsedUrl = parsedUrl;

    const pathname = normalizePath(parsedUrl.pathname);
    const pathSegments = pathname.split("/").filter(Boolean);
    const method = req.method ? req.method.toUpperCase() : "GET";

    for (const route of routes) {
      if (route.method !== method) {
        continue;
      }

      if (route.path === pathname) {
        req.params = {};
        await route.handler(req, res);
        return true;
      }

      if (!route.segments || route.segments.length !== pathSegments.length) {
        continue;
      }

      const params = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i];
        const current = pathSegments[i];
        if (segment.startsWith(":")) {
          const key = segment.slice(1);
          params[key] = decodeURIComponent(current || "");
        } else if (segment !== current) {
          matched = false;
          break;
        }
      }

      if (matched) {
        req.params = params;
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
