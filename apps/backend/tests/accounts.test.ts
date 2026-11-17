/** Creating and promoting accounts. Each refused create or promote also checks that nothing was written. */

import { describe, it, expect, beforeEach } from "vitest";
import { getAll, getOne, run } from "../src/db/index.ts";
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

describe("accounts", () => {
  async function tenant(slug: string): Promise<string> {
    return (await TenantService.create({ slug, name: slug })).id;
  }

  async function userCount(): Promise<number> {
    return (
      (await getOne("SELECT COUNT(*) as count FROM users")) as {
        count: number;
      }
    ).count;
  }

  async function user(username: string) {
    return (
      ((await getOne("SELECT * FROM users WHERE username = ?", [username])) as {
        id: string;
        role: string;
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
        "SELECT username FROM users WHERE is_platform_operator = 1 ORDER BY username",
      )) as Array<{ username: string }>
    ).map((row) => row.username);
  }

  function reasonOf<T>(result: Result<T, { reason: AccountErrorReason }>) {
    return result.ok ? null : result.error.reason;
  }

  describe("creating an account", () => {
    it("makes an admin of the only tenant, with a membership there", async () => {
      const tenantId = await tenant("totem");

      const result = await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );

      expect(result.ok).toBe(true);
      const row = (await user("maria"))!;
      expect(row.role).toBe("admin");
      expect(row.is_platform_operator).toBe(0);
      expect(row.created_by).toBeNull();
      expect(await MembershipService.roleFor(tenantId, row.id)).toBe("admin");
    });

    it("tells the caller which tenant it joined", async () => {
      const tenantId = await tenant("totem");

      const result = await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );

      expect(result.ok && result.value.tenant).toEqual({
        id: tenantId,
        slug: "totem",
      });
    });

    it("stores a hash of the password, never the password", async () => {
      await tenant("totem");

      await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );

      const { password_hash } = (await user("maria"))!;
      expect(password_hash).not.toContain(PASSWORD);
      expect(await verifyPassword(PASSWORD, password_hash)).toBe(true);
    });

    it("names the account after its username unless given a display name", async () => {
      await tenant("totem");

      await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );
      await AccountService.create(
        {
          username: "juan",
          password: PASSWORD,
          name: "Juan Pérez",
        },
        OPERATOR,
      );

      expect((await user("maria"))!.name).toBe("maria");
      expect((await user("juan"))!.name).toBe("Juan Pérez");
    });

    it("makes a platform operator with no membership", async () => {
      await tenant("totem");

      const result = await AccountService.create(
        {
          username: "vendeya-staff",
          password: PASSWORD,
          platformOperator: true,
        },
        OPERATOR,
      );

      expect(result.ok && result.value.isPlatformOperator).toBe(true);
      expect(result.ok && result.value.tenant).toBeNull();
      expect((await user("vendeya-staff"))!.is_platform_operator).toBe(1);
      expect(
        await getOne("SELECT COUNT(*) as count FROM tenant_memberships"),
      ).toEqual({ count: 0 });
    });

    it("makes a platform operator where there is no tenant at all", async () => {
      const result = await AccountService.create(
        {
          username: "vendeya-staff",
          password: PASSWORD,
          platformOperator: true,
        },
        OPERATOR,
      );

      expect(result.ok).toBe(true);
      expect(await operators()).toEqual(["vendeya-staff"]);
    });

    describe("with several tenants", () => {
      let alpha: string;
      let beta: string;

      beforeEach(async () => {
        alpha = await tenant("alpha");
        beta = await tenant("beta");
      });

      it("joins the tenant it is told to", async () => {
        const result = await AccountService.create(
          {
            username: "maria",
            password: PASSWORD,
            tenantId: beta,
          },
          OPERATOR,
        );

        expect(result.ok).toBe(true);
        const { id } = (await user("maria"))!;
        expect(await MembershipService.roleFor(beta, id)).toBe("admin");
        expect(await MembershipService.roleFor(alpha, id)).toBeNull();
      });

      it("is refused without one, and the refusal lists them", async () => {
        const request = { username: "maria", password: PASSWORD };
        const result = await AccountService.create(request, OPERATOR);

        expect(reasonOf(result)).toBe("tenant_required");
        expect(!result.ok && result.error.message).toContain(alpha);
        expect(!result.ok && result.error.message).toContain(beta);
        expect(await user("maria")).toBeUndefined();
      });
    });

    it("refuses a tenant that does not exist", async () => {
      await tenant("totem");

      const result = await AccountService.create(
        {
          username: "maria",
          password: PASSWORD,
          tenantId: "tn-nowhere",
        },
        OPERATOR,
      );

      expect(reasonOf(result)).toBe("unknown_tenant");
      expect(await userCount()).toBe(0);
    });

    it("refuses a database with no tenant to join", async () => {
      const result = await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );

      expect(reasonOf(result)).toBe("no_tenant");
      expect(await userCount()).toBe(0);
    });

    it("refuses to be both a platform operator and a member of a tenant", async () => {
      const tenantId = await tenant("totem");

      const result = await AccountService.create(
        {
          username: "maria",
          password: PASSWORD,
          platformOperator: true,
          tenantId,
        },
        OPERATOR,
      );

      expect(reasonOf(result)).toBe("conflicting_scope");
      expect(await userCount()).toBe(0);
    });

    describe("the password", () => {
      it("is refused under 12 characters, and nothing is written", async () => {
        await tenant("totem");

        const result = await AccountService.create(
          {
            username: "maria",
            password: "x".repeat(11),
          },
          OPERATOR,
        );

        expect(reasonOf(result)).toBe("password_too_short");
        expect(await userCount()).toBe(0);
        expect(
          await getOne("SELECT COUNT(*) as count FROM tenant_memberships"),
        ).toEqual({ count: 0 });
      });

      it("is accepted at exactly 12", async () => {
        await tenant("totem");

        const result = await AccountService.create(
          {
            username: "maria",
            password: "x".repeat(12),
          },
          OPERATOR,
        );

        expect(result.ok).toBe(true);
      });
    });

    describe("a username that is taken", () => {
      beforeEach(async () => {
        await tenant("totem");
        await AccountService.create(
          { username: "maria", password: PASSWORD },
          OPERATOR,
        );
      });

      it("is refused, and the account that holds it is untouched", async () => {
        const before = (await user("maria"))!;

        const result = await AccountService.create(
          {
            username: "maria",
            password: "a-different-password",
            platformOperator: true,
          },
          OPERATOR,
        );

        expect(reasonOf(result)).toBe("username_taken");
        expect(await user("maria")).toEqual(before);
        expect(await userCount()).toBe(1);
      });

      it("is refused by the check made before a password is asked for", async () => {
        expect(
          reasonOf(await AccountService.checkNew({ username: "maria" })),
        ).toBe("username_taken");
        expect((await AccountService.checkNew({ username: "juan" })).ok).toBe(
          true,
        );
      });
    });

    it("refuses an empty username or one wrapped in whitespace", async () => {
      await tenant("totem");

      for (const username of ["", "   ", " maria", "maria "]) {
        expect(
          reasonOf(
            await AccountService.create(
              { username, password: PASSWORD },
              OPERATOR,
            ),
          ),
        ).toBe("invalid_username");
      }
      expect(await userCount()).toBe(0);
    });

    it("checks everything but the password before one exists", async () => {
      const alpha = await tenant("alpha");
      await tenant("beta");

      expect(
        reasonOf(await AccountService.checkNew({ username: "maria" })),
      ).toBe("tenant_required");
      expect(
        (await AccountService.checkNew({ username: "maria", tenantId: alpha }))
          .ok,
      ).toBe(true);
      expect(
        (
          await AccountService.checkNew({
            username: "maria",
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
      tenantId = await tenant("totem");
      await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );
      await AccountService.create(
        { username: "juan", password: PASSWORD },
        OPERATOR,
      );
    });

    it("makes an existing account a platform operator", async () => {
      const result = await AccountService.promote("maria", OPERATOR);

      expect(result.ok && result.value).toMatchObject({
        username: "maria",
        changed: true,
      });
      expect(await operators()).toEqual(["maria"]);
    });

    it("keeps the account's tenant membership", async () => {
      await AccountService.promote("maria", OPERATOR);

      expect(
        await MembershipService.roleFor(tenantId, (await user("maria"))!.id),
      ).toBe("admin");
    });

    it("leaves every other account alone", async () => {
      await AccountService.promote("maria", OPERATOR);

      expect((await user("juan"))!.is_platform_operator).toBe(0);
    });

    it("changes nothing the second time, and says so", async () => {
      await AccountService.promote("maria", OPERATOR);

      const again = await AccountService.promote("maria", OPERATOR);

      expect(again.ok && again.value.changed).toBe(false);
      expect(await operators()).toEqual(["maria"]);
    });

    it("is refused for a username nobody holds", async () => {
      const result = await AccountService.promote("nobody", OPERATOR);

      expect(reasonOf(result)).toBe("not_found");
      expect(await operators()).toEqual([]);
    });

    it("is refused for a disabled account", async () => {
      await run("UPDATE users SET is_active = 0 WHERE username = 'maria'");

      const result = await AccountService.promote("maria", OPERATOR);

      expect(reasonOf(result)).toBe("inactive");
      expect(await operators()).toEqual([]);
    });

    it("counts an account whose active flag was never set as active", async () => {
      await run("UPDATE users SET is_active = NULL WHERE username = 'maria'");

      expect((await AccountService.promote("maria", OPERATOR)).ok).toBe(true);
      expect(await operators()).toEqual(["maria"]);
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
      const tenantId = await tenant("totem");

      const result = await AccountService.create(
        { username: "maria", password: PASSWORD },
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
        username: "maria",
        role: "admin",
        platformOperator: false,
        uid: OPERATOR.uid,
      });
    });

    it("stores the name the environment gave and the uid it could not change", async () => {
      await tenant("totem");
      const spoofed = { name: "alice", uid: 1000 };

      await AccountService.create(
        { username: "maria", password: PASSWORD },
        spoofed,
      );
      await AccountService.promote("maria", spoofed);

      const rows = await auditRows();
      expect(rows.map((row) => row.actor)).toEqual(["cli:alice", "cli:alice"]);
      expect(rows.map((row) => JSON.parse(row.metadata).uid)).toEqual([
        1000, 1000,
      ]);
    });

    it("records a created platform operator with no tenant", async () => {
      await tenant("totem");

      await AccountService.create(
        { username: "staff", password: PASSWORD, platformOperator: true },
        OPERATOR,
      );

      const [row, ...rest] = await auditRows();
      expect(rest).toEqual([]);
      expect(row!.tenant_id).toBeNull();
      expect(JSON.parse(row!.metadata)).toEqual({
        username: "staff",
        platformOperator: true,
        uid: OPERATOR.uid,
      });
    });

    it("never records the password", async () => {
      await tenant("totem");

      await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );

      const stored = JSON.stringify(await auditRows());
      expect(stored).not.toContain(PASSWORD);
      expect(stored).not.toContain((await user("maria"))!.password_hash);
    });

    it("writes nothing when the password is too short", async () => {
      await tenant("totem");

      await AccountService.create(
        { username: "maria", password: "short" },
        OPERATOR,
      );

      expect(await auditRows()).toEqual([]);
    });

    it("writes nothing when the username is taken", async () => {
      await tenant("totem");
      await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );

      await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );

      expect(await auditRows()).toHaveLength(1);
    });

    it("writes nothing when the tenant is refused", async () => {
      await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );

      expect(await auditRows()).toEqual([]);
    });

    it("rolls the account back when its row cannot be written", async () => {
      await tenant("totem");
      await run("DROP TABLE audit_log");

      await expect(
        AccountService.create(
          { username: "maria", password: PASSWORD },
          OPERATOR,
        ),
      ).rejects.toThrow();
      expect(await user("maria")).toBeUndefined();
    });

    describe("on promotion", () => {
      beforeEach(async () => {
        await tenant("totem");
        await AccountService.create(
          { username: "maria", password: PASSWORD },
          OPERATOR,
        );
        await run("DELETE FROM audit_log");
      });

      it("records one row, in no tenant even though the account belongs to one", async () => {
        await AccountService.promote("maria", OPERATOR);

        const [row, ...rest] = await auditRows();
        expect(rest).toEqual([]);
        expect(row).toMatchObject({
          tenant_id: null,
          user_id: null,
          actor: `cli:${OPERATOR.name}`,
          action: "promote_platform_operator",
          resource_type: "user",
          resource_id: (await user("maria"))!.id,
        });
        expect(JSON.parse(row!.metadata)).toEqual({
          username: "maria",
          platformOperator: true,
          uid: OPERATOR.uid,
        });
      });

      it("records no tenant for an account that belongs to several either", async () => {
        await MembershipService.upsert({
          tenantId: await tenant("other"),
          userId: (await user("maria"))!.id,
          role: "admin",
          createdBy: null,
        });

        await AccountService.promote("maria", OPERATOR);

        expect((await auditRows()).map((row) => row.tenant_id)).toEqual([null]);
      });

      it("writes nothing when the account was already a platform operator", async () => {
        await AccountService.promote("maria", OPERATOR);
        await run("DELETE FROM audit_log");

        await AccountService.promote("maria", OPERATOR);

        expect(await auditRows()).toEqual([]);
      });

      it("writes nothing for an unknown or disabled account", async () => {
        await AccountService.promote("nobody", OPERATOR);
        await run("UPDATE users SET is_active = 0");
        await AccountService.promote("maria", OPERATOR);

        expect(await auditRows()).toEqual([]);
      });

      it("leaves the account unpromoted when its row cannot be written", async () => {
        await run("DROP TABLE audit_log");

        await expect(
          AccountService.promote("maria", OPERATOR),
        ).rejects.toThrow();
        expect((await user("maria"))!.is_platform_operator).toBe(0);
      });
    });
  });

  describe("knowing whether anybody holds the platform operator's powers", () => {
    beforeEach(async () => {
      await tenant("totem");
    });

    it("is no for a database of ordinary accounts", async () => {
      await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );

      expect(await AccountService.hasPlatformOperator()).toBe(false);
    });

    it("is yes once one is created", async () => {
      await AccountService.create(
        {
          username: "staff",
          password: PASSWORD,
          platformOperator: true,
        },
        OPERATOR,
      );

      expect(await AccountService.hasPlatformOperator()).toBe(true);
    });

    it("is yes once an account is promoted", async () => {
      await AccountService.create(
        { username: "maria", password: PASSWORD },
        OPERATOR,
      );
      await AccountService.promote("maria", OPERATOR);

      expect(await AccountService.hasPlatformOperator()).toBe(true);
    });

    it("is no when the only operator is disabled", async () => {
      await AccountService.create(
        {
          username: "staff",
          password: PASSWORD,
          platformOperator: true,
        },
        OPERATOR,
      );
      await run("UPDATE users SET is_active = 0");

      expect(await AccountService.hasPlatformOperator()).toBe(false);
    });
  });
});
