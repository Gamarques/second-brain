import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  accountStatusEnum,
  createdAtColumn,
  idColumn,
  instantColumn,
  membershipRoleEnum,
  updatedAtColumn,
} from "./common.js";

export const accounts = pgTable(
  "accounts",
  {
    id: idColumn(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: accountStatusEnum("status").notNull().default("active"),
    role: membershipRoleEnum("role").notNull(),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: instantColumn("locked_until"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("accounts_email_normalized_key").on(sql`lower(${table.email})`),
    check(
      "accounts_email_normalized_check",
      sql`${table.email} = lower(btrim(${table.email})) and length(${table.email}) between 3 and 320`,
    ),
    check(
      "accounts_failed_login_count_check",
      sql`${table.failedLoginCount} >= 0`,
    ),
  ],
);

export const oauthSettings = pgTable("oauth_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export const oauthArtifacts = pgTable(
  "oauth_artifacts",
  {
    model: text("model").notNull(),
    id: text("id").notNull(),
    payload: jsonb("payload").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    clientId: text("client_id"),
    grantId: text("grant_id"),
    userCode: text("user_code"),
    uid: text("uid"),
    expiresAt: instantColumn("expires_at"),
    consumedAt: instantColumn("consumed_at"),
  },
  (table) => [
    primaryKey({ name: "oauth_artifacts_pkey", columns: [table.model, table.id] }),
    index("oauth_artifacts_grant_idx").on(table.model, table.grantId),
    uniqueIndex("oauth_artifacts_user_code_key")
      .on(table.model, table.userCode)
      .where(sql`${table.userCode} is not null`),
    uniqueIndex("oauth_artifacts_uid_key")
      .on(table.model, table.uid)
      .where(sql`${table.uid} is not null`),
    index("oauth_artifacts_expiry_idx").on(table.expiresAt),
    index("oauth_artifacts_account_idx").on(table.accountId, table.model),
    index("oauth_artifacts_client_idx").on(table.clientId, table.model),
  ],
);
