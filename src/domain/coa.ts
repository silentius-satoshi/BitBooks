/** PB-1 · Default CoA preset — "Bitcoiner Sole Operator" (master spec §6.1). */
import { Account } from './types';

const A = (
  id: string, name: string, type: Account['type'], parentId: string | null,
  extra: Partial<Account> = {},
): Account => ({ id, name, type, commodity: 'USD', parentId, ...extra });

export const COA_BITCOINER_SOLE_OPERATOR: Account[] = [
  // Assets
  A('assets', 'Assets', 'ASSET', null, { placeholder: true }),
  A('bank:checking', 'Bank:Checking', 'BANK', 'assets'),
  A('cash', 'Cash', 'CASH', 'assets'),
  A('btc:cold', 'Bitcoin:Cold Storage', 'ASSET', 'assets',
    { commodity: 'BTC', lotMethod: 'FIFO', custodian: 'self-custody' }),
  A('btc:strike', 'Bitcoin:Strike Collateral', 'ASSET', 'assets',
    { commodity: 'BTC', lotMethod: 'FIFO', custodian: 'Strike' }),
  A('btc:coinbase', 'Bitcoin:Coinbase Collateral', 'ASSET', 'assets',
    { commodity: 'BTC', lotMethod: 'FIFO', custodian: 'Coinbase' }),
  A('ar', 'Accounts Receivable', 'AR', 'assets'),
  // Liabilities
  A('liab', 'Liabilities', 'LIABILITY', null, { placeholder: true }),
  A('cc', 'Credit Card', 'CREDIT', 'liab'),
  A('loc:strike', 'Strike BLOC', 'LIABILITY', 'liab'),
  A('loc:coinbase', 'Coinbase Loan', 'LIABILITY', 'liab'),
  A('ap', 'Accounts Payable', 'AP', 'liab'),
  // Equity
  A('equity', 'Equity', 'EQUITY', null, { placeholder: true }),
  A('equity:opening', 'Opening Balances', 'EQUITY', 'equity'),
  // Income
  A('income', 'Income', 'INCOME', null, { placeholder: true }),
  A('income:sales', 'Sales', 'INCOME', 'income'),
  A('income:consulting', 'Consulting', 'INCOME', 'income'),
  A('income:realized-gain', 'Realized Gain on Bitcoin', 'INCOME', 'income'),
  // Expenses
  A('exp', 'Expenses', 'EXPENSE', null, { placeholder: true }),
  A('exp:rent', 'Rent', 'EXPENSE', 'exp'),
  A('exp:software', 'Software & Subscriptions', 'EXPENSE', 'exp'),
  A('exp:groceries', 'Groceries', 'EXPENSE', 'exp'),
  A('exp:utilities', 'Utilities', 'EXPENSE', 'exp'),
  A('exp:insurance', 'Insurance', 'EXPENSE', 'exp'),
  A('exp:travel', 'Travel', 'EXPENSE', 'exp'),
  A('exp:meals', 'Meals', 'EXPENSE', 'exp'),
  A('exp:phone', 'Phone & Internet', 'EXPENSE', 'exp'),
  A('exp:professional', 'Professional Services', 'EXPENSE', 'exp'),
  A('exp:hardware', 'Hardware', 'EXPENSE', 'exp'),
  A('exp:misc', 'Miscellaneous', 'EXPENSE', 'exp'),
  A('exp:loan-interest', 'Loan Interest', 'EXPENSE', 'exp'),
  A('exp:realized-loss', 'Realized Loss on Bitcoin', 'EXPENSE', 'exp'),
  A('exp:network-fees', 'Network Fees', 'EXPENSE', 'exp'),
];
