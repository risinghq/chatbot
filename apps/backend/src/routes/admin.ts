import { Hono } from "hono";
import users from "./admin/users.ts";
import invitations from "./admin/invitations.ts";
import system from "./admin/system.ts";
import channels from "./admin/channels.ts";

const admin = new Hono();

admin.route("/users", users);
admin.route("/invitations", invitations);
admin.route("/channels", channels);
admin.route("/", system);

export default admin;
