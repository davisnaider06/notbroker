-- A casa virou de opções binárias: uma conta só, em BRL, começando em R$ 10.000.
-- Saldos e posições do modelo à vista não têm equivalente, então todas as contas recomeçam.
DELETE FROM "wallets" WHERE "currency" <> 'BRL';--> statement-breakpoint
INSERT INTO "wallets" ("user_id", "currency", "balance", "locked")
SELECT "id", 'BRL', 10000, 0 FROM "user"
ON CONFLICT ("user_id", "currency") DO UPDATE SET "balance" = 10000, "locked" = 0;
