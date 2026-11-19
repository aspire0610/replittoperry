import app from "../../../artifacts/api-server/dist/app.mjs";

const automationStatusRoute = "/api/account/paper-trading/automation/status";

export default function handler(req, res) {
  const [pathname, search = ""] = (req.url ?? "/").split("?", 2);
  const params = new URLSearchParams(search);
  if (params.get("__route") === automationStatusRoute) {
    params.delete("__route");
    const query = params.toString();
    req.url = `${automationStatusRoute}${query ? `?${query}` : ""}`;
  }
  return app(req, res);
}
