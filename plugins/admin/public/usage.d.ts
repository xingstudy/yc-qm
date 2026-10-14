export function usageDate(at?: number): string;
export function usageRange(preset: string, now?: number): { start: string; end: string };
export function usageAutoRefresh(
  state: { visible: boolean; active: boolean; enabled: boolean; end: string },
  now?: number,
): boolean;
export function mountUsageDashboard(root: unknown, options?: { base?: string; locale?: string }): { destroy(): void };
export function usageMetric(metrics: Record<string, number> | null, key: string): number | null;
export function usagePeriods(
  start: string,
  end: string,
  granularity: string,
  series: Array<{ period: string; metrics: Record<string, number> }>,
): Array<{ period: string; metrics: Record<string, number> | null; partial: boolean }>;
