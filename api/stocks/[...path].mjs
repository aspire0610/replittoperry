import app from "../../artifacts/api-server/dist/app.mjs";

const allowedDeepRoutes = new Set([
  "/api/stocks/ai-picks/progress",
  "/api/stocks/ai-picks/scan-jobs",
]);
const scanJobRoute = /^\/api\/stocks\/ai-picks\/scan-jobs\/\d+$/;

export default function handler(req, res) {
  const [pathname, search = ""] = (req.url ?? "/").split("?", 2);
  const params = new URLSearchParams(search);
  const route = params.get("__route");

  if (route && (allowedDeepRoutes.has(route) || scanJobRoute.test(route))) {
    params.delete("__route");
    const query = params.toString();
    req.url = `${route}${query ? `?${query}` : ""}`;
  }

  return app(req, res);
}
