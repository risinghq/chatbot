import { defineParams } from "@sveltejs/kit/params";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const params = defineParams({
  /** A business id. It keeps /dashboard/negocios and the like out of the business routes. */
  uuid: (param) => (UUID.test(param) ? param : undefined),
});
