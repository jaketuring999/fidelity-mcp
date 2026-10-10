// Only the summary entry surface is established by the saved/live adapter
// evidence. Add routes here only after validating their page context contract.
export const fidelityPage = {
  origin: 'https://digital.fidelity.com',
  portfolioPath: '/ftgw/digital/portfolio/summary',
} as const;
export type FidelityPagePolicy = typeof fidelityPage;
export const portfolioUrl = fidelityPage.origin + fidelityPage.portfolioPath;
export const fidelityTabPattern = fidelityPage.origin + '/*';

export function isFidelityUrl(value?: string): boolean {
  try {
    return value !== undefined && new URL(value).origin === fidelityPage.origin;
  } catch {
    return false;
  }
}
export function isPortfolioUrl(value?: string): boolean {
  try {
    if (value === undefined) return false;
    const url = new URL(value);
    return url.origin === fidelityPage.origin && url.pathname === fidelityPage.portfolioPath;
  } catch {
    return false;
  }
}
