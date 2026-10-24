/**
 * 额度水位条（原 QuotaProgressBar 的类型化后继）。
 *
 * dataviz 语法：细轨道退居背景，填充按剩余量三档着色（≥70 绿 / ≥30 琥珀 / <30 红），
 * percent === null 渲染空轨道 —— 未知不着色（Medium 类在 width 0 下不可见，行为与旧版一致）。
 * `index` 写入 `--meter-index`，供全页外衣做逐行入场级差；紧凑外衣不消费该变量。
 */

import type { CSSProperties } from 'react';
import type { QuotaClassMap } from '../types';
import { shownPercent, useMeterDisplay } from '../meterDisplay';

export const QUOTA_PROGRESS_HIGH_THRESHOLD = 70;
export const QUOTA_PROGRESS_MEDIUM_THRESHOLD = 30;

export interface QuotaMeterProps {
  /** Remaining percent. */
  percent: number | null;
  classes: QuotaClassMap;
  index?: number;
  /** The window id, so a window running out at this pace shows red. */
  meterId?: string;
}

export function QuotaMeter({ percent, classes, index, meterId }: QuotaMeterProps) {
  const { mode, atPace } = useMeterDisplay();
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const normalized = percent === null ? null : clamp(percent, 0, 100);
  // Colour follows what is left; a window that runs out before its reset at
  // this pace is red even with plenty left.
  const fillClass =
    normalized === null
      ? classes.quotaBarFillMedium
      : meterId !== undefined && atPace.has(meterId)
        ? classes.quotaBarFillLow
        : normalized >= QUOTA_PROGRESS_HIGH_THRESHOLD
          ? classes.quotaBarFillHigh
          : normalized >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
            ? classes.quotaBarFillMedium
            : classes.quotaBarFillLow;
  const widthPercent =
    Math.round((normalized === null ? 0 : shownPercent(normalized, mode)) * 100) / 100;
  const style: CSSProperties & { '--meter-index'?: number } = { width: `${widthPercent}%` };
  if (index !== undefined) {
    style['--meter-index'] = index;
  }

  return (
    <div className={classes.quotaBar}>
      <div className={`${classes.quotaBarFill} ${fillClass}`} style={style} />
    </div>
  );
}
