CREATE TYPE "public"."trade_direction" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."trade_status" AS ENUM('open', 'won', 'lost', 'draw', 'refunded');--> statement-breakpoint
CREATE TABLE "binary_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"direction" "trade_direction" NOT NULL,
	"status" "trade_status" NOT NULL,
	"stake" numeric(30, 10) NOT NULL,
	"payout_rate" numeric(30, 10) NOT NULL,
	"entry_price" numeric(30, 10) NOT NULL,
	"exit_price" numeric(30, 10),
	"payout" numeric(30, 10),
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "binary_trades" ADD CONSTRAINT "binary_trades_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binary_trades" ADD CONSTRAINT "binary_trades_symbol_instruments_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."instruments"("symbol") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "binary_trades_user_opened_idx" ON "binary_trades" USING btree ("user_id","opened_at");--> statement-breakpoint
CREATE INDEX "binary_trades_status_idx" ON "binary_trades" USING btree ("status");