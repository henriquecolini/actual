import { getAccountDb } from '../src/account-db';

export const up = async function () {
  const accountDb = getAccountDb();

  // Per-user opt-in: lets the in-app assistant change the budget directly
  // instead of only proposing changes. Off unless the user turns it on.
  accountDb.exec(`
    ALTER TABLE ai_settings ADD COLUMN allow_writes INTEGER NOT NULL DEFAULT 0;
  `);
};

export const down = async function () {
  const accountDb = getAccountDb();

  accountDb.exec(`
    ALTER TABLE ai_settings DROP COLUMN allow_writes;
  `);
};
