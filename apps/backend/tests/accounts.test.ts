/** Creating and promoting accounts. Each refused create or promote also checks that nothing was written. */

import { describe, it, expect, beforeEach } from "vitest";
import { newId } from "@vendeya/utils";
import { getAll, getOne, run } from "./helpers/db.ts";
import type { AccountErrorReason } from "../src/domains/accounts/errors.ts";
import { AccountService } from "../src/domains/accounts/index.ts";
import {
  MembershipService,
  TenantService,
} from "../src/domains/tenants/index.ts";
import { verifyPassword } from "../src/platform/auth/password.ts";
import type { Result } from "../src/shared/result/index.ts";

const PASSWORD = "a-long-enough-password";
const OPERATOR = { name: "operator", uid: 1000 };
const MARIA = "maria@example.com";
const JUAN = "juan@example.com";
const STAFF = "staff@example.com";

describe("accounts", () => {
  async function tenant(name: string): Promise<string> {
    return (await TenantService.create({ name })).id;
  }

  async function userCount(): Promise<number> {
    return (
      (await getOne("SELECT COUNT(*) as count FROM users")) as {
        count: number;
      }
    ).count;
  }

  async function user(email: string) {
    return (
      ((await getOne("SELECT * FROM users WHERE email = ?", [email])) as {
        id: string;
        name: string;
        password_hash: string;
        is_platform_operator: number;
        is_active: number | null;
        created_by: string | null;
      } | null) ?? undefined
    );
  }

  async function operators(): Promise<string[]> {
    return (
      (await getAll(
        "SELECT email FROM users WHERE is_platform_operator = 1 ORDER BY email",
      )) as Array<{ email: string }>
    ).map((row) => row.email);
  }

  function reasonOf<T>(result: Result<T, { reason: AccountErrorReason }>) {
    return result.ok ? null : result.error.reason;
  }

  describe("creating an account", () => {
    it("makes an admin of the only tenant, with a membership there", async () => {
      const tenantId = await tenant("Tienda Uno");

      const result = await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      expect(result.ok).toBe(true);
      const row = (await user(MARIA))!;
      expect(row.is_platform_operator).toBe(0);
      expect(row.created_by).toBeNull();
      expect(await MembershipService.roleFor(tenantId, row.id)).toBe("admin");
    });

    it("tells the caller which tenant it joined", async () => {
      const tenantId = await tenant("Tienda Uno");

      const result = await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      expect(result.ok && result.value.tenant).toEqual({
        id: tenantId,
        name: "Tienda Uno",
      });
    });

    it("stores a hash of the password, never the password", async () => {
      await tenant("Tienda Uno");

      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      const { password_hash } = (await user(MARIA))!;
      expect(password_hash).not.toContain(PASSWORD);
      expect(await verifyPassword(PASSWORD, password_hash)).toBe(true);
    });

    it("names the account after its email unless given a display name", async () => {
      await tenant("Tienda Uno");

      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );
      await AccountService.create(
        { email: JUAN, password: PASSWORD, name: "Juan Pérez" },
        OPERATOR,
      );

      expect((await user(MARIA))!.name).toBe(MARIA);
      expect((await user(JUAN))!.name).toBe("Juan Pérez");
    });

    it("stores the email trimmed and in lower case", async () => {
      await tenant("Tienda Uno");

      const result = await AccountService.create(
        { email: "  Maria@Example.COM ", password: PASSWORD },
        OPERATOR,
      );

      expect(result.ok && result.value.email).toBe(MARIA);
      expect(await user(MARIA)).toBeDefined();
    });

    it("makes a platform operator with no membership", async () => {
      await tenant("Tienda Uno");

      const result = await AccountService.create(
        { email: STAFF, password: PASSWORD, platformOperator: true },
        OPERATOR,
      );

      expect(result.ok && result.value.isPlatformOperator).toBe(true);
      expect(result.ok && result.value.tenant).toBeNull();
      expect((await user(STAFF))!.is_platform_operator).toBe(1);
      expect(
        await getOne("SELECT COUNT(*) as count FROM tenant_memberships"),
      ).toEqual({ count: 0 });
    });

    it("makes a platform operator where there is no tenant at all", async () => {
      const result = await AccountService.create(
        { email: STAFF, password: PASSWORD, platformOperator: true },
        OPERATOR,
      );

      expect(result.ok).toBe(true);
      expect(await operators()).toEqual([STAFF]);
    });

    describe("with several tenants", () => {
      let alpha: string;
      let beta: string;

      beforeEach(async () => {
        alpha = await tenant("Alpha");
        beta = await tenant("Beta");
      });

      it("joins the tenant it is told to", async () => {
        const result = await AccountService.create(
          { email: MARIA, password: PASSWORD, tenantId: beta },
          OPERATOR,
        );

        expect(result.ok).toBe(true);
        const { id } = (await user(MARIA))!;
        expect(await MembershipService.roleFor(beta, id)).toBe("admin");
        expect(await MembershipService.roleFor(alpha, id)).toBeNull();
      });

      it("is refused without one, and the refusal lists them", async () => {
        const request = { email: MARIA, password: PASSWORD };
        const result = await AccountService.create(request, OPERATOR);

        expect(reasonOf(result)).toBe("tenant_required");
        expect(!result.ok && result.error.message).toContain(alpha);
        expect(!result.ok && result.error.message).toContain(beta);
        expect(await user(MARIA)).toBeUndefined();
      });
    });

    it("refuses a tenant that does not exist", async () => {
      await tenant("Tienda Uno");

      const result = await AccountService.create(
        { email: MARIA, password: PASSWORD, tenantId: newId() },
        OPERATOR,
      );

      expect(reasonOf(result)).toBe("unknown_tenant");
      expect(await userCount()).toBe(0);
    });

    it("refuses a database with no tenant to join", async () => {
      const result = await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      expect(reasonOf(result)).toBe("no_tenant");
      expect(await userCount()).toBe(0);
    });

    it("refuses to be both a platform operator and a member of a tenant", async () => {
      const tenantId = await tenant("Tienda Uno");

      const result = await AccountService.create(
        { email: MARIA, password: PASSWORD, platformOperator: true, tenantId },
        OPERATOR,
      );

      expect(reasonOf(result)).toBe("conflicting_scope");
      expect(await userCount()).toBe(0);
    });

    describe("the password", () => {
      it("is refused under 12 characters, and nothing is written", async () => {
        await tenant("Tienda Uno");

        const result = await AccountService.create(
          { email: MARIA, password: "x".repeat(11) },
          OPERATOR,
        );

        expect(reasonOf(result)).toBe("password_too_short");
        expect(await userCount()).toBe(0);
        expect(
          await getOne("SELECT COUNT(*) as count FROM tenant_memberships"),
        ).toEqual({ count: 0 });
      });

      it("is accepted at exactly 12", async () => {
        await tenant("Tienda Uno");

        const result = await AccountService.create(
          { email: MARIA, password: "x".repeat(12) },
          OPERATOR,
        );

        expect(result.ok).toBe(true);
      });
    });

    describe("an email that is taken", () => {
      beforeEach(async () => {
        await tenant("Tienda Uno");
        await AccountService.create(
          { email: MARIA, password: PASSWORD },
          OPERATOR,
        );
      });

      it("is refused, and the account that holds it is untouched", async () => {
        const before = (await user(MARIA))!;

        const result = await AccountService.create(
          {
            email: MARIA,
            password: "a-different-password",
            platformOperator: true,
          },
          OPERATOR,
        );

        expect(reasonOf(result)).toBe("email_taken");
        expect(await user(MARIA)).toEqual(before);
        expect(await userCount()).toBe(1);
      });

      it("is refused when typed in other capitals", async () => {
        const result = await AccountService.create(
          { email: "MARIA@example.com", password: PASSWORD },
          OPERATOR,
        );

        expect(reasonOf(result)).toBe("email_taken");
        expect(await userCount()).toBe(1);
      });

      it("is refused by the check made before a password is asked for", async () => {
        expect(reasonOf(await AccountService.checkNew({ email: MARIA }))).toBe(
          "email_taken",
        );
        expect((await AccountService.checkNew({ email: JUAN })).ok).toBe(true);
      });
    });

    it("refuses anything that is not an email address", async () => {
      await tenant("Tienda Uno");

      for (const email of ["", "   ", "maria", "maria@", "maria @x.com"]) {
        expect(
          reasonOf(
            await AccountService.create(
              { email, password: PASSWORD },
              OPERATOR,
            ),
          ),
        ).toBe("invalid_email");
      }
      expect(await userCount()).toBe(0);
    });

    it("checks everything but the password before one exists", async () => {
      const alpha = await tenant("Alpha");
      await tenant("Beta");

      expect(reasonOf(await AccountService.checkNew({ email: MARIA }))).toBe(
        "tenant_required",
      );
      expect(
        (await AccountService.checkNew({ email: MARIA, tenantId: alpha })).ok,
      ).toBe(true);
      expect(
        (
          await AccountService.checkNew({
            email: MARIA,
            platformOperator: true,
          })
        ).ok,
      ).toBe(true);
      expect(await userCount()).toBe(0);
    });
  });

  describe("promoting an account", () => {
    let tenantId: string;

    beforeEach(async () => {
      tenantId = await tenant("Tienda Uno");
      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );
      await AccountService.create(
        { email: JUAN, password: PASSWORD },
        OPERATOR,
      );
    });

    it("makes an existing account a platform operator", async () => {
      const result = await AccountService.promote(MARIA, OPERATOR);

      expect(result.ok && result.value).toMatchObject({
        email: MARIA,
        changed: true,
      });
      expect(await operators()).toEqual([MARIA]);
    });

    it("keeps the account's tenant membership", async () => {
      await AccountService.promote(MARIA, OPERATOR);

      expect(
        await MembershipService.roleFor(tenantId, (await user(MARIA))!.id),
      ).toBe("admin");
    });

    it("leaves every other account alone", async () => {
      await AccountService.promote(MARIA, OPERATOR);

      expect((await user(JUAN))!.is_platform_operator).toBe(0);
    });

    it("changes nothing the second time, and says so", async () => {
      await AccountService.promote(MARIA, OPERATOR);

      const again = await AccountService.promote(MARIA, OPERATOR);

      expect(again.ok && again.value.changed).toBe(false);
      expect(await operators()).toEqual([MARIA]);
    });

    it("is refused for an email nobody holds", async () => {
      const result = await AccountService.promote(
        "nobody@example.com",
        OPERATOR,
      );

      expect(reasonOf(result)).toBe("not_found");
      expect(await operators()).toEqual([]);
    });

    it("is refused for a disabled account", async () => {
      await run("UPDATE users SET is_active = 0 WHERE email = ?", [MARIA]);

      const result = await AccountService.promote(MARIA, OPERATOR);

      expect(reasonOf(result)).toBe("inactive");
      expect(await operators()).toEqual([]);
    });
  });

  describe("the audit trail", () => {
    type AuditRow = {
      tenant_id: string | null;
      user_id: string | null;
      actor: string;
      action: string;
      resource_type: string;
      resource_id: string | null;
      metadata: string;
    };

    async function auditRows(): Promise<AuditRow[]> {
      return (await getAll(
        "SELECT * FROM audit_log ORDER BY created_at, rowid",
      )) as AuditRow[];
    }

    it("records a created admin under the operator and the tenant it joined", async () => {
      const tenantId = await tenant("Tienda Uno");

      const result = await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      const [row, ...rest] = await auditRows();
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        tenant_id: tenantId,
        user_id: null,
        actor: `cli:${OPERATOR.name}`,
        action: "create_user",
        resource_type: "user",
        resource_id: result.ok ? result.value.id : null,
      });
      expect(JSON.parse(row!.metadata)).toEqual({
        email: MARIA,
        role: "admin",
        platformOperator: false,
        uid: OPERATOR.uid,
      });
    });

    it("stores the name the environment gave and the uid it could not change", async () => {
      await tenant("Tienda Uno");
      const spoofed = { name: "alice", uid: 1000 };

      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        spoofed,
      );
      await AccountService.promote(MARIA, spoofed);

      const rows = await auditRows();
      expect(rows.map((row) => row.actor)).toEqual(["cli:alice", "cli:alice"]);
      expect(rows.map((row) => JSON.parse(row.metadata).uid)).toEqual([
        1000, 1000,
      ]);
    });

    it("records a created platform operator with no tenant", async () => {
      await tenant("Tienda Uno");

      await AccountService.create(
        { email: STAFF, password: PASSWORD, platformOperator: true },
        OPERATOR,
      );

      const [row, ...rest] = await auditRows();
      expect(rest).toEqual([]);
      expect(row!.tenant_id).toBeNull();
      expect(JSON.parse(row!.metadata)).toEqual({
        email: STAFF,
        platformOperator: true,
        uid: OPERATOR.uid,
      });
    });

    it("never records the password", async () => {
      await tenant("Tienda Uno");

      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      const stored = JSON.stringify(await auditRows());
      expect(stored).not.toContain(PASSWORD);
      expect(stored).not.toContain((await user(MARIA))!.password_hash);
    });

    it("writes nothing when the password is too short", async () => {
      await tenant("Tienda Uno");

      await AccountService.create(
        { email: MARIA, password: "short" },
        OPERATOR,
      );

      expect(await auditRows()).toEqual([]);
    });

    it("writes nothing when the email is taken", async () => {
      await tenant("Tienda Uno");
      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      expect(await auditRows()).toHaveLength(1);
    });

    it("writes nothing when the tenant is refused", async () => {
      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      expect(await auditRows()).toEqual([]);
    });

    it("rolls the account back when its row cannot be written", async () => {
      await tenant("Tienda Uno");
      await run("DROP TABLE audit_log");

      await expect(
        AccountService.create({ email: MARIA, password: PASSWORD }, OPERATOR),
      ).rejects.toThrow();
      expect(await user(MARIA)).toBeUndefined();
    });

    describe("on promotion", () => {
      beforeEach(async () => {
        await tenant("Tienda Uno");
        await AccountService.create(
          { email: MARIA, password: PASSWORD },
          OPERATOR,
        );
        await run("DELETE FROM audit_log");
      });

      it("records one row, in no tenant even though the account belongs to one", async () => {
        await AccountService.promote(MARIA, OPERATOR);

        const [row, ...rest] = await auditRows();
        expect(rest).toEqual([]);
        expect(row).toMatchObject({
          tenant_id: null,
          user_id: null,
          actor: `cli:${OPERATOR.name}`,
          action: "promote_platform_operator",
          resource_type: "user",
          resource_id: (await user(MARIA))!.id,
        });
        expect(JSON.parse(row!.metadata)).toEqual({
          email: MARIA,
          platformOperator: true,
          uid: OPERATOR.uid,
        });
      });

      it("records no tenant for an account that belongs to several either", async () => {
        await MembershipService.upsert({
          tenantId: await tenant("Otra"),
          userId: (await user(MARIA))!.id,
          role: "admin",
          createdBy: null,
        });

        await AccountService.promote(MARIA, OPERATOR);

        expect((await auditRows()).map((row) => row.tenant_id)).toEqual([null]);
      });

      it("writes nothing when the account was already a platform operator", async () => {
        await AccountService.promote(MARIA, OPERATOR);
        await run("DELETE FROM audit_log");

        await AccountService.promote(MARIA, OPERATOR);

        expect(await auditRows()).toEqual([]);
      });

      it("writes nothing for an unknown or disabled account", async () => {
        await AccountService.promote("nobody@example.com", OPERATOR);
        await run("UPDATE users SET is_active = 0");
        await AccountService.promote(MARIA, OPERATOR);

        expect(await auditRows()).toEqual([]);
      });

      it("leaves the account unpromoted when its row cannot be written", async () => {
        await run("DROP TABLE audit_log");

        await expect(AccountService.promote(MARIA, OPERATOR)).rejects.toThrow();
        expect((await user(MARIA))!.is_platform_operator).toBe(0);
      });
    });
  });

  describe("knowing whether anybody holds the platform operator's powers", () => {
    beforeEach(async () => {
      await tenant("Tienda Uno");
    });

    it("is no for a database of ordinary accounts", async () => {
      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );

      expect(await AccountService.hasPlatformOperator()).toBe(false);
    });

    it("is yes once one is created", async () => {
      await AccountService.create(
        { email: STAFF, password: PASSWORD, platformOperator: true },
        OPERATOR,
      );

      expect(await AccountService.hasPlatformOperator()).toBe(true);
    });

    it("is yes once an account is promoted", async () => {
      await AccountService.create(
        { email: MARIA, password: PASSWORD },
        OPERATOR,
      );
      await AccountService.promote(MARIA, OPERATOR);

      expect(await AccountService.hasPlatformOperator()).toBe(true);
    });

    it("is no when the only operator is disabled", async () => {
      await AccountService.create(
        { email: STAFF, password: PASSWORD, platformOperator: true },
        OPERATOR,
      );
      await run("UPDATE users SET is_active = 0");

      expect(await AccountService.hasPlatformOperator()).toBe(false);
    });
  });
});
