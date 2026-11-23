export {};

declare global {
  namespace App {
    interface Locals {
      user: {
        id: string;
        email: string;
        /**
         * Admin for a platform operator. Anyone else has their membership role
         * in the business the URL names, or null outside one.
         */
        role: string | null;
        name: string;
        /** VendeYa staff, who act across tenants rather than inside one. */
        isPlatformOperator: boolean;
        /** The business last opened, which /dashboard opens again. */
        lastTenantId: string | null;
      } | null;
    }
  }
}
