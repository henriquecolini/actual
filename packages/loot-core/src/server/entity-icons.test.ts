import * as db from '#server/db';

import { app as accountsApp } from './accounts/app';
import { app as budgetApp } from './budget/app';

describe('entity icons', () => {
  beforeEach(global.emptyDatabase());

  it('stores and returns an account icon and color via account-update', async () => {
    await db.insertAccount({ id: 'acct1', name: 'Nubank' });

    await accountsApp.handlers['account-update']({
      id: 'acct1',
      icon: 'bank:nubank',
      icon_color: '#820ad1',
    });

    const [account] = await accountsApp.handlers['accounts-get']();
    expect(account).toMatchObject({
      id: 'acct1',
      name: 'Nubank',
      icon: 'bank:nubank',
      icon_color: '#820ad1',
    });
  });

  it('leaves the icon alone when account-update does not mention it', async () => {
    await db.insertAccount({ id: 'acct1', name: 'Nubank' });
    await accountsApp.handlers['account-update']({
      id: 'acct1',
      icon: 'tabler:wallet',
      icon_color: '#3b82f6',
    });

    await accountsApp.handlers['account-update']({
      id: 'acct1',
      name: 'Renamed',
    });

    const [account] = await accountsApp.handlers['accounts-get']();
    expect(account).toMatchObject({
      name: 'Renamed',
      icon: 'tabler:wallet',
      icon_color: '#3b82f6',
    });
  });

  it('clears an account icon when null is sent', async () => {
    await db.insertAccount({ id: 'acct1', name: 'Nubank' });
    await accountsApp.handlers['account-update']({
      id: 'acct1',
      icon: 'tabler:wallet',
      icon_color: '#3b82f6',
    });

    await accountsApp.handlers['account-update']({
      id: 'acct1',
      icon: null,
      icon_color: null,
    });

    const [account] = await accountsApp.handlers['accounts-get']();
    expect(account.icon).toBeNull();
    expect(account.icon_color).toBeNull();
  });

  it('stores a category icon and color via category-update', async () => {
    await db.insertCategoryGroup({ id: 'group1', name: 'Bills' });
    await db.insertCategory({
      id: 'cat1',
      name: 'Groceries',
      cat_group: 'group1',
    });

    await budgetApp.handlers['category-update']({
      id: 'cat1',
      name: 'Groceries',
      group: 'group1',
      icon: 'tabler:shopping-cart',
      icon_color: '#22c55e',
    });

    const [category] = await db.getCategories(['cat1']);
    expect(category).toMatchObject({
      id: 'cat1',
      icon: 'tabler:shopping-cart',
      icon_color: '#22c55e',
    });
  });
});
