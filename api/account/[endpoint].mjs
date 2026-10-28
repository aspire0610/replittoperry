import app from "../../artifacts/api-server/dist/app.mjs";

const stockResearchAgentRoute =
  /^\/api\/account\/stock-research-agents\/[^/]+(?:\/run)?$/;

export default function handler(req, res) {
  const [pathname, search = ""] = (req.url ?? "/").split("?", 2);
  const params = new URLSearchParams(search);
  const route = params.get("__route");

  if (route && stockResearchAgentRoute.test(route)) {
    params.delete("__route");
    const query = params.toString();
    req.url = `${route}${query ? `?${query}` : ""}`;
  }

  return app(req, res);
}