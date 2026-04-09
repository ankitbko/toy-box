export const SIDEBAR_SIZE_COOKIE = "toybox_sidebar_size";
export const SIDEBAR_OPEN_COOKIE = "toybox_sidebar_open";
export const AUTOMATIONS_EXPANDED_COOKIE = "toybox_automations_expanded";
export const LOGS_OPEN_COOKIE = "toybox_logs_open";
export const LOGS_SIZE_COOKIE = "toybox_logs_size";
export const LAYOUT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const DEFAULT_SIDEBAR_SIZE = 15;
export const DEFAULT_AUTOMATIONS_EXPANDED = true;
export const DEFAULT_LOGS_OPEN = false;
export const DEFAULT_LOGS_SIZE = 25;

export const SIDEBAR_MIN_SIZE = 10;
export const SIDEBAR_MAX_SIZE = 40;

export type LayoutPrefs = {
  sidebarSize: number;
  sidebarOpen: boolean;
  automationsExpanded: boolean;
  logsOpen: boolean;
  logsSize: number;
};

function parseCookies(header?: string | null): Record<string, string> {
  if (!header) return {};

  return header.split(";").reduce<Record<string, string>>((acc, part) => {
    const trimmed = part.trim();
    if (!trimmed) return acc;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return acc;
    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (name) acc[name] = value;
    return acc;
  }, {});
}

function parseCookieNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCookieBoolean(value?: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function parseLayoutPrefs(cookieHeader?: string | null): Partial<LayoutPrefs> {
  const cookies = parseCookies(cookieHeader);
  return {
    sidebarSize: parseCookieNumber(cookies[SIDEBAR_SIZE_COOKIE]),
    sidebarOpen: parseCookieBoolean(cookies[SIDEBAR_OPEN_COOKIE]),
    automationsExpanded: parseCookieBoolean(cookies[AUTOMATIONS_EXPANDED_COOKIE]),
    logsOpen: parseCookieBoolean(cookies[LOGS_OPEN_COOKIE]),
    logsSize: parseCookieNumber(cookies[LOGS_SIZE_COOKIE]),
  };
}

export function clampSidebarSize(value: number): number {
  return Math.min(SIDEBAR_MAX_SIZE, Math.max(SIDEBAR_MIN_SIZE, value));
}

export function resolveLayoutPrefs(prefs: Partial<LayoutPrefs>): LayoutPrefs {
  return {
    sidebarSize: clampSidebarSize(prefs.sidebarSize ?? DEFAULT_SIDEBAR_SIZE),
    sidebarOpen: prefs.sidebarOpen ?? true,
    automationsExpanded: prefs.automationsExpanded ?? DEFAULT_AUTOMATIONS_EXPANDED,
    logsOpen: prefs.logsOpen ?? DEFAULT_LOGS_OPEN,
    logsSize: prefs.logsSize ?? DEFAULT_LOGS_SIZE,
  };
}

export function buildLayoutCookie(name: string, value: string | number | boolean): string {
  return `${name}=${String(value)}; Path=/; Max-Age=${LAYOUT_COOKIE_MAX_AGE}; SameSite=Lax`;
}
