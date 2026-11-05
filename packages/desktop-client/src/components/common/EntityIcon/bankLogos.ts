export type BankInfo = {
  slug: string;
  name: string;
  /** Brand background color (6-digit hex). */
  color: string;
};

// Logos live in src/assets/bank-logos/<slug>.svg. To add a bank, drop in the
// SVG and add one line here.
export const BANKS: readonly BankInfo[] = [
  { slug: 'nubank', name: 'Nubank', color: '#820ad1' },
  { slug: 'itau', name: 'Itaú', color: '#ff6200' },
  { slug: 'inter', name: 'Inter', color: '#ea7100' },
  { slug: 'caixa', name: 'Caixa', color: '#ffffff' },
  { slug: 'c6', name: 'C6 Bank', color: '#000000' },
  { slug: 'bradesco', name: 'Bradesco', color: '#cc092f' },
  { slug: 'santander', name: 'Santander', color: '#ea1d25' },
  { slug: 'btg', name: 'BTG', color: '#001e61' },
  { slug: 'sicoob', name: 'Sicoob', color: '#003641' },
  { slug: 'safra', name: 'Safra', color: '#1e2044' },
  { slug: 'picpay', name: 'PicPay', color: '#21c25e' },
  { slug: 'mercadopago', name: 'Mercado Pago', color: '#ffe700' },
  { slug: 'pagbank', name: 'PagBank', color: '#ffffff' },
  { slug: 'pan', name: 'Pan', color: '#00a0fd' },
  { slug: 'neon', name: 'Neon', color: '#00a0fd' },
  { slug: 'next', name: 'Next', color: '#00ff5f' },
  { slug: 'carrefour', name: 'Carrefour', color: '#ffffff' },
  { slug: 'generic', name: 'Generic', color: '#e2e8f0' },
];

const logoUrlsByPath = import.meta.glob<string>(
  '../../../assets/bank-logos/*.svg',
  { query: '?url', import: 'default', eager: true },
);

const logoUrls: Record<string, string> = {};
for (const [path, url] of Object.entries(logoUrlsByPath)) {
  const slug = path
    .split('/')
    .pop()
    ?.replace(/\.svg$/, '');
  if (slug) {
    logoUrls[slug] = url;
  }
}

export function getBank(slug: string): BankInfo | undefined {
  return BANKS.find(bank => bank.slug === slug);
}

export function getBankLogoUrl(slug: string): string | undefined {
  return logoUrls[slug];
}
