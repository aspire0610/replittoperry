import app from "../../artifacts/api-server/dist/app.mjs";

const etfMarketRoute = "/api/etfs/market";

export default function handler(req, res) {
  const [, search = ""] = (req.url ?? "/").split("?", 2);
  const params = new URLSearchParams(search);
  const route = params.get("__route");

  if (route === etfMarketRoute) {
    params.delete("__route");
    const query = params.toString();
    req.url = `${route}${query ? `?${query}` : ""}`;
  }

  return app(req, res);
}