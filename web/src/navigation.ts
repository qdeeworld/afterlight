import type { Role } from "./model.ts";

export function roleNavigationUrl(currentUrl: string, role: Role): string {
  const url = new URL(currentUrl);
  url.searchParams.set("role", role);
  return `${url.pathname}${url.search}${url.hash}`;
}
