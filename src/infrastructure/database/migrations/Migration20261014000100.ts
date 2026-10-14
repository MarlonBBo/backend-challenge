import { Migration } from '@mikro-orm/migrations';

export class Migration20261014000100 extends Migration {
  override up(): void {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" char(3) not null,
        "balance" numeric(20,2) not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_balance_non_negative" check ("balance" >= 0),
        constraint "wallets_version_positive" check ("version" >= 1),
        constraint "wallets_currency_format" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(100) not null,
        "external_transaction_id" varchar(255) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" char(64) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(255) not null,
        "game_id" varchar(255) not null,
        "kind" varchar(16) not null,
        "status" varchar(32) not null,
        "amount" numeric(20,2) not null,
        "currency" char(3) not null,
        "reference_external_transaction_id" varchar(255) null,
        "reference_transaction_id" uuid null,
        "failure_code" varchar(64) null,
        "result_balance" numeric(20,2) null,
        "reference_attempts" integer not null default 0,
        "next_reference_attempt_at" timestamptz null,
        "created_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key"),
        constraint "wager_transactions_wallet_fk" foreign key ("wallet_id") references "wallets" ("id"),
        constraint "wager_transactions_reference_fk" foreign key ("reference_transaction_id") references "wager_transactions" ("id"),
        constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_amount_non_negative" check ("amount" >= 0),
        constraint "wager_transactions_result_balance_non_negative" check ("result_balance" is null or "result_balance" >= 0),
        constraint "wager_transactions_reference_attempts_non_negative" check ("reference_attempts" >= 0),
        constraint "wager_transactions_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_reference_required" check (
          "kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null
        )
      );
    `);

    this.addSql(`
      create unique index "wager_transactions_processed_reversal_unique"
      on "wager_transactions" ("reference_transaction_id", "kind")
      where "reference_transaction_id" is not null
        and "kind" in ('REFUND', 'ROLLBACK')
        and "status" = 'PROCESSED';
    `);

    this.addSql(`
      create index "wager_transactions_pending_reference_idx"
      on "wager_transactions" ("next_reference_attempt_at", "created_at")
      where "status" = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(8) not null,
        "amount" numeric(20,2) not null,
        "currency" char(3) not null,
        "balance_before" numeric(20,2) not null,
        "balance_after" numeric(20,2) not null,
        "created_at" timestamptz not null,
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_wallet_transaction_unique" unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_entries_wallet_fk" foreign key ("wallet_id") references "wallets" ("id"),
        constraint "wallet_ledger_entries_transaction_fk" foreign key ("transaction_id") references "wager_transactions" ("id"),
        constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_amount_positive" check ("amount" > 0),
        constraint "wallet_ledger_entries_balances_non_negative" check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_entries_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_entries_balanced" check (
          ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount") or
          ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
        )
      );
    `);

    this.addSql(`
      create index "wallet_ledger_entries_wallet_cursor_idx"
      on "wallet_ledger_entries" ("wallet_id", "created_at" desc, "id" desc);
    `);

    this.addSql(`
      create function prevent_wallet_ledger_mutation()
      returns trigger as $$
      begin
        raise exception 'wallet ledger entries are immutable';
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_immutable"
      before update or delete on "wallet_ledger_entries"
      for each row execute function prevent_wallet_ledger_mutation();
    `);

    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(100) not null,
        "message_id" varchar(255) not null,
        "payload_hash" char(64) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id")
      );
    `);

    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(100) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz null,
        "published_at" timestamptz null,
        constraint "outbox_messages_pkey" primary key ("id"),
        constraint "outbox_messages_attempts_non_negative" check ("attempts" >= 0),
        constraint "outbox_messages_payload_object" check (jsonb_typeof("payload") = 'object')
      );
    `);

    this.addSql(`
      create index "outbox_messages_pending_idx"
      on "outbox_messages" (coalesce("next_attempt_at", "occurred_at"), "occurred_at")
      where "published_at" is null;
    `);
  }

  override down(): void {
    this.addSql('drop table if exists "outbox_messages" cascade;');
    this.addSql('drop table if exists "inbox_messages" cascade;');
    this.addSql(
      'drop trigger if exists "wallet_ledger_entries_immutable" on "wallet_ledger_entries";',
    );
    this.addSql('drop function if exists prevent_wallet_ledger_mutation();');
    this.addSql('drop table if exists "wallet_ledger_entries" cascade;');
    this.addSql('drop table if exists "wager_transactions" cascade;');
    this.addSql('drop table if exists "wallets" cascade;');
  }
}
