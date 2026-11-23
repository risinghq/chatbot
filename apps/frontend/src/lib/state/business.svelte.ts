import { page } from "$app/state";

/**
 * A path inside the business the page is in: `businessPath("/orders")`. A
 * business page lives under /dashboard/[tenantId], so its links name it too.
 */
export function businessPath(path = ""): string {
  return `/dashboard/${page.params.tenantId}${path}`;
}

/**
 * The same page in another business, for the switcher. A record's page (an
 * order, a customer) has no twin there, so it falls back to the section.
 */
export function samePageIn(tenantId: string, pathname: string): string {
  const [, , , section] = pathname.split("/");
  return section
    ? `/dashboard/${tenantId}/${section}`
    : `/dashboard/${tenantId}`;
}
