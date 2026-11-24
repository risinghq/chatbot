import { Hono } from "hono";
import users from "./admin/users.ts";
import invitations from "./admin/invitations.ts";
import system from "./admin/system.ts";
import channels from "./admin/channels.ts";
import business from "./admin/business.ts";
import taypi from "./admin/taypi.ts";
import instagram from "./admin/instagram.ts";
import shopify from "./shopify.ts";

const admin = new Hono();

admin.route("/business", business);
admin.route("/users", users);
admin.route("/invitations", invitations);
admin.route("/channels", channels);
admin.route("/taypi", taypi);
admin.route("/shopify", shopify);
admin.route("/instagram", instagram);
admin.route("/", system);

export default admin;
