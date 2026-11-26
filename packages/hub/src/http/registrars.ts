/** 生产路由注册表：每个面只负责声明 endpoint → handler，匹配仍归 contracts。 */
import { registerCatalogRoutes } from "./catalog.js";
import { registerDispatchRuleRoutes } from "./dispatch-rules.js";
import { registerDocumentRoutes } from "./documents.js";
import { registerPeopleRoutes } from "./people.js";
import { EndpointRouter } from "./router.js";
import { registerSocialRoutes } from "./social.js";
import { registerWorkRoutes } from "./work.js";

export function buildDomainRouter(): EndpointRouter {
  const router = new EndpointRouter();
  registerPeopleRoutes(router);
  registerSocialRoutes(router);
  registerWorkRoutes(router);
  registerDocumentRoutes(router);
  registerCatalogRoutes(router);
  registerDispatchRuleRoutes(router);
  return router;
}
