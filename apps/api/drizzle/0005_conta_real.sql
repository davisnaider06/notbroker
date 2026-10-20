CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'paid', 'failed', 'expired', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."pix_key_type" AS ENUM('cpf', 'cnpj', 'phone', 'email', 'random');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('requested', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."account_kind" AS ENUM('demo', 'real');--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(30, 10) NOT NULL,
	"status" "deposit_status" DEFAULT 'pending' NOT NULL,
	"gateway_id" text,
	"pix_code" text,
	"document" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	CONSTRAINT "deposits_gateway_id_unique" UNIQUE("gateway_id")
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(30, 10) NOT NULL,
	"fee" numeric(30, 10),
	"status" "withdrawal_status" DEFAULT 'requested' NOT NULL,
	"gateway_id" text,
	"owner_name" text NOT NULL,
	"document" text NOT NULL,
	"pix_key_type" "pix_key_type" NOT NULL,
	"pix_key" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	CONSTRAINT "withdrawals_gateway_id_unique" UNIQUE("gateway_id")
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "account" "account_kind" DEFAULT 'demo' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "wallets_user_id_currency_pk";--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_account_currency_pk" PRIMARY KEY("user_id","account","currency");--> statement-breakpoint
ALTER TABLE "binary_trades" ADD COLUMN "account" "account_kind" DEFAULT 'demo' NOT NULL;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposits_user_created_idx" ON "deposits" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "deposits_status_idx" ON "deposits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "withdrawals_user_created_idx" ON "withdrawals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "withdrawals_status_idx" ON "withdrawals" USING btree ("status");--> statement-breakpoint
-- Contas que já existiam ganham a carteira real, vazia. As novas recebem as duas no cadastro.
INSERT INTO "wallets" ("user_id", "account", "currency", "balance", "starting_balance")
SELECT "user_id", 'real', "currency", '0', '0' FROM "wallets" WHERE "account" = 'demo'
ON CONFLICT DO NOTHING;
