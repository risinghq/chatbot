import type {
  CampaignSummary,
  MessageTemplate,
  ReminderSettings,
} from "@vendeya/types";
import { DEFAULT_REMINDER_SETTINGS } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  const headers = { cookie: `session=${sessionToken}` };
  if (!sessionToken) {
    return {
      templates: [] as MessageTemplate[],
      campaigns: [] as CampaignSummary[],
      reminders: DEFAULT_REMINDER_SETTINGS,
    };
  }

  const [templates, campaigns, reminders] = await Promise.all([
    fetch("/api/campaigns/templates", { headers })
      .then((r) => (r.ok ? r.json<MessageTemplate[]>() : []))
      .catch(() => [] as MessageTemplate[]),
    fetch("/api/campaigns", { headers })
      .then((r) => (r.ok ? r.json<CampaignSummary[]>() : []))
      .catch(() => [] as CampaignSummary[]),
    fetch("/api/campaigns/settings/reminders", { headers })
      .then((r) =>
        r.ok ? r.json<ReminderSettings>() : DEFAULT_REMINDER_SETTINGS,
      )
      .catch(() => DEFAULT_REMINDER_SETTINGS),
  ]);
  return { templates, campaigns, reminders };
};
