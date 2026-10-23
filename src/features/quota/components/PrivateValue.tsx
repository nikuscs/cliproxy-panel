/**
 * A private value (email, account name) shown blurred until revealed. Click,
 * Enter or Space reveals just this one; click again, click elsewhere or Escape
 * blurs it back. While blurred it can't be selected or copied, and screen
 * readers hear a neutral label instead of the value.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { usePrivacyRevealed } from '../privacy';
import styles from './PrivateValue.module.scss';

export interface PrivateValueProps {
  value: string;
  className?: string;
}

export function PrivateValue({ value, className }: PrivateValueProps) {
  const { t } = useTranslation();
  const revealAll = usePrivacyRevealed();
  const [revealed, setRevealed] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!revealed) return;
    const blurOutside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setRevealed(false);
    };
    document.addEventListener('pointerdown', blurOutside);
    return () => document.removeEventListener('pointerdown', blurOutside);
  }, [revealed]);

  if (revealAll) {
    return (
      <span className={className} title={value}>
        {value}
      </span>
    );
  }

  const toggle = (event: MouseEvent) => {
    // Inside clickable rows and cards: reveal only, never trigger the parent.
    event.stopPropagation();
    setRevealed((current) => !current);
  };
  const handleKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      setRevealed((current) => !current);
    } else if (event.key === 'Escape') {
      setRevealed(false);
    }
  };
  const hiddenLabel = t(
    value.includes('@')
      ? 'quota_management.privacy_hidden_email'
      : 'quota_management.privacy_hidden_name'
  );

  return (
    <span
      ref={ref}
      role="button"
      tabIndex={0}
      aria-pressed={revealed}
      aria-label={revealed ? value : hiddenLabel}
      title={revealed ? value : t('quota_management.privacy_reveal_hint')}
      className={[styles.value, revealed ? styles.revealed : styles.blurred, className ?? '']
        .filter(Boolean)
        .join(' ')}
      onClick={toggle}
      onKeyDown={handleKey}
    >
      <span aria-hidden={!revealed}>{value}</span>
    </span>
  );
}
