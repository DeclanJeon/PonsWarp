const CLOUD_ROUTE_PATTERN = /\/cloud\/([a-z0-9-]{8,80})(?:[^a-z0-9-]|$)/i;
const CLOUD_CODE_PATTERN = /^[A-Z0-9-]{8,80}$/;

export const normalizeCloudShareCodeInput = (input: string): string | null => {
  const trimmed = input.trim();
  const cloudRouteMatch = trimmed.match(CLOUD_ROUTE_PATTERN);
  const candidate = cloudRouteMatch ? cloudRouteMatch[1] : trimmed;
  const normalized = candidate.replace(/[^a-z0-9-]/gi, '').toUpperCase();

  return CLOUD_CODE_PATTERN.test(normalized) ? normalized : null;
};

export const formatCloudShareCode = (shareId: string): string =>
  shareId.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
