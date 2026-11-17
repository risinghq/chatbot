import type { Conversation } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) {
    return { conversations: [] };
  }

  try {
    const response = await fetch("/api/conversations", {
      headers: { cookie: `session=${sessionToken}` },
    });

    if (response.ok) {
      return { conversations: await response.json<Conversation[]>() };
    }
  } catch {}

  return { conversations: [] };
};
