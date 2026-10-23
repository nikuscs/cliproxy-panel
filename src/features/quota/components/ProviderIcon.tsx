/**
 * Provider brand mark in a small rounded tile, as used by the ledger rows, the
 * provider group card and the per-provider forecast header.
 */

import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import styles from './ProviderIcon.module.scss';

export interface ProviderIconProps {
  provider: string;
  resolvedTheme: ResolvedTheme;
  size?: 'sm' | 'md';
}

export function ProviderIcon({ provider, resolvedTheme, size = 'md' }: ProviderIconProps) {
  const { t } = useTranslation();
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const typeLabel = getTypeLabel(t, provider);
  return (
    <span
      className={`${styles.wrap} ${size === 'sm' ? styles.small : ''}`.trim()}
      title={typeLabel}
      style={
        isThemeSurfaceIconProvider(provider)
          ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
          : undefined
      }
    >
      {iconSrc ? (
        <img src={iconSrc} alt="" className={styles.icon} />
      ) : (
        <span className={styles.fallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
