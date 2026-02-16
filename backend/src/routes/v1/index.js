const { chartinkWebhook } = require("../../controllers/webhook.controller");
const {
  register,
  login,
  adminLogin,
  me,
} = require("../../controllers/auth.controller");
const {
  create,
  list,
} = require("../../controllers/strategy.controller");
const { list: listAlerts } = require("../../controllers/alerts.controller");
const { webhook: telegramWebhook } = require("../../controllers/telegram.controller");
const { createToken, listTokens } = require("../../controllers/telegramToken.controller");
const {
  list: listPlans,
  requestPlan,
  listUserRequests,
} = require("../../controllers/plan.controller");
const {
  listUsers,
  updatePlan,
  listTelegramSubscribers,
  deactivateTelegramSubscriber,
  listTelegramTokens,
  createPlanAdmin,
  listPlansAdmin,
  listPlanRequestsAdmin,
  updatePlanRequestAdmin,
  sendTelegramAdminMessage,
  setTelegramWebhook,
  getTelegramWebhookInfo,
  getTelegramStatus,
  listStrategiesAdmin,
  listAlertsAdmin,
} = require("../../controllers/admin.controller");
const { requireAuth, requireAdmin } = require("../../middlewares/auth");

function registerV1Routes(router) {
  router.post("/api/v1/webhooks/chartink", chartinkWebhook);

  router.post("/api/v1/auth/register", register);
  router.post("/api/v1/auth/login", login);
  router.post("/api/v1/auth/admin/login", adminLogin);
  router.get("/api/v1/auth/me", requireAuth(me));

  router.post("/api/v1/strategies", requireAuth(create));
  router.get("/api/v1/strategies", requireAuth(list));

  router.get("/api/v1/alerts", requireAuth(listAlerts));

  router.post("/api/v1/telegram/webhook", telegramWebhook);
  router.post("/api/v1/telegram/token", requireAuth(createToken));
  router.get("/api/v1/telegram/token", requireAuth(listTokens));

  router.get("/api/v1/plans", listPlans);
  router.post("/api/v1/plans/request", requireAuth(requestPlan));
  router.get("/api/v1/plans/requests", requireAuth(listUserRequests));

  router.get("/api/v1/admin/users", requireAdmin(listUsers));
  router.post("/api/v1/admin/users/plan", requireAdmin(updatePlan));
  router.get("/api/v1/admin/telegram/subscribers", requireAdmin(listTelegramSubscribers));
  router.post("/api/v1/admin/telegram/subscribers/deactivate", requireAdmin(deactivateTelegramSubscriber));
  router.get("/api/v1/admin/telegram/tokens", requireAdmin(listTelegramTokens));
  router.post("/api/v1/admin/telegram/send", requireAdmin(sendTelegramAdminMessage));
  router.post("/api/v1/admin/telegram/webhook", requireAdmin(setTelegramWebhook));
  router.get("/api/v1/admin/telegram/webhook", requireAdmin(getTelegramWebhookInfo));
  router.get("/api/v1/admin/telegram/status", requireAdmin(getTelegramStatus));
  router.get("/api/v1/admin/strategies", requireAdmin(listStrategiesAdmin));
  router.get("/api/v1/admin/alerts", requireAdmin(listAlertsAdmin));
  router.post("/api/v1/admin/plans", requireAdmin(createPlanAdmin));
  router.get("/api/v1/admin/plans", requireAdmin(listPlansAdmin));
  router.get("/api/v1/admin/plan-requests", requireAdmin(listPlanRequestsAdmin));
  router.post("/api/v1/admin/plan-requests/update", requireAdmin(updatePlanRequestAdmin));
}

module.exports = { registerV1Routes };
