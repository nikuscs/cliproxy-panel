/**
 * A value with more detail on hover or keyboard focus: a styled popover in
 * place of a native tooltip. It renders in a portal with fixed positioning,
 * so cards and scroll areas never clip it, and closes on Escape or scroll.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './DetailPopover.module.scss';

export interface DetailPopoverProps {
  /** The popover content; strings with line breaks show one line each. */
  detail: ReactNode;
  className?: string;
  children: ReactNode;
}

export function DetailPopover({ detail, className, children }: DetailPopoverProps) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const open = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 6, left: rect.left });
  };
  const close = () => setPosition(null);

  useEffect(() => {
    if (!position) return;
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [position]);

  return (
    <span
      ref={ref}
      tabIndex={0}
      className={[styles.trigger, className ?? ''].filter(Boolean).join(' ')}
      aria-describedby={position ? id : undefined}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      {children}
      {position &&
        createPortal(
          <span id={id} role="tooltip" className={styles.popover} style={position}>
            {detail}
          </span>,
          document.body
        )}
    </span>
  );
}
