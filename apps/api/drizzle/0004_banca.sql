ALTER TABLE "wallets" ADD COLUMN "starting_balance" numeric(30, 10) DEFAULT '10000' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Contas que já existiam: a banca começou no cadastro, então o histórico inteiro entra no desempenho.
UPDATE "wallets" SET "started_at" = "user"."created_at" FROM "user" WHERE "user"."id" = "wallets"."user_id";
