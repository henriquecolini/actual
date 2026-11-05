BEGIN TRANSACTION;

-- Optional icon + background color for categories and accounts.
-- `icon` is "<set>:<name>" (e.g. "tabler:shopping-cart" or "bank:nubank").
-- `icon_color` is a hex background color (e.g. "#820ad1").
ALTER TABLE categories ADD COLUMN icon TEXT DEFAULT NULL;
ALTER TABLE categories ADD COLUMN icon_color TEXT DEFAULT NULL;
ALTER TABLE accounts ADD COLUMN icon TEXT DEFAULT NULL;
ALTER TABLE accounts ADD COLUMN icon_color TEXT DEFAULT NULL;

COMMIT;
