# VendeYa manual

This manual is for the staff and contributors who run or change VendeYa. Each
page owns one subject. Links point to the page that defines a rule instead of
repeating it.

1. [Get started](./get-started.md): install the repository and use the
   simulator.
2. [How a conversation runs](./conversation.md): follow a message from webhook
   intake through a reply, retry, or handoff.
3. [The dashboard](./dashboard.md): understand the frontend routes and add a
   dashboard page. [Dashboard design](./design.md) holds its visual rules.
4. [Tenancy](./tenancy.md): manage tenant scope, roles, channel accounts, and
   encrypted credentials.
5. [Campaigns](./campaigns.md): send template messages to groups of customers
   and keep the cart and inactive-customer reminders.
6. [Eligibility](./eligibility.md): understand the optional Cálidda credit
   check, its providers and their outages.
7. [Connecting WhatsApp](./whatsapp.md): register a number and configure Meta's
   callback.
8. [Connecting Instagram](./instagram.md): register a professional account and
   set its comment replies.
9. [Shopify](./shopify.md): connect a store, keep the catalog in step and write
   orders back.
10. [Deploy](./deploy.md): create the Cloudflare resources, set the secrets,
    deploy the Workers, and restore the database.
11. [Operations](./operations.md): inspect health and logs, manage accounts, and
    investigate missing replies.
12. [Development](./development.md): run checks, find CI jobs, and follow code
    conventions.

Contributors should also read the [architecture map](./architecture.md) before
changing code.
