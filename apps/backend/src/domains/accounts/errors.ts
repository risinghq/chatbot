export type AccountErrorReason =
  | "invalid_email"
  | "invalid_name"
  | "password_too_short"
  | "wrong_password"
  | "email_taken"
  | "conflicting_scope"
  | "no_tenant"
  | "tenant_required"
  | "unknown_tenant"
  | "not_found"
  | "inactive";

export class AccountError extends Error {
  constructor(
    public readonly reason: AccountErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export type NewAccount = {
  email: string;
  name?: string;
  platformOperator?: boolean;
  tenantId?: string;
};

export type CreatedAccount = {
  id: string;
  email: string;
  name: string;
  isPlatformOperator: boolean;
  tenant: { id: string; name: string } | null;
};

export type PromotedAccount = {
  id: string;
  email: string;
  changed: boolean;
};

export type SignUp = {
  email: string;
  password: string;
  name: string;
  businessName: string;
};
