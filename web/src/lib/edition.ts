/** Single-organisation (Board of Revenue) build: multi-organisation screens are hidden. Set VITE_SINGLE_TENANT=false to show them. */
export const SINGLE_TENANT = import.meta.env.VITE_SINGLE_TENANT !== 'false';
export const DEFAULT_TENANT = (import.meta.env.VITE_DEFAULT_TENANT as string | undefined) ?? 'bor-bahawalpur';
