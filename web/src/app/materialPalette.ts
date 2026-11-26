import {
  Hct,
  MaterialDynamicColors as colors,
  SchemeTonalSpot,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities'

const roles = {
  surface: colors.surface,
  'surface-container-low': colors.surfaceContainerLow,
  'surface-container': colors.surfaceContainer,
  'surface-container-high': colors.surfaceContainerHigh,
  'on-surface': colors.onSurface,
  'on-surface-variant': colors.onSurfaceVariant,
  primary: colors.primary,
  'on-primary': colors.onPrimary,
  'primary-container': colors.primaryContainer,
  'on-primary-container': colors.onPrimaryContainer,
  'secondary-container': colors.secondaryContainer,
  'on-secondary-container': colors.onSecondaryContainer,
  outline: colors.outline,
  'outline-variant': colors.outlineVariant,
  error: colors.error,
  'on-error': colors.onError,
}

export const applyMaterialPalette = (style: CSSStyleDeclaration, seed: string, dark: boolean) => {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(seed)), dark, 0)
  for (const [role, color] of Object.entries(roles)) {
    style.setProperty('--md-' + role, hexFromArgb(color.getArgb(scheme)))
  }
  style.setProperty('--pad-accent-hover', hexFromArgb(scheme.primaryPalette.tone(dark ? 75 : 44)))
  style.setProperty('--pad-accent-wash-hover', hexFromArgb(scheme.secondaryPalette.tone(dark ? 35 : 85)))
}
