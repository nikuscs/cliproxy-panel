/**
 * Privacy on the quota page. Account names and emails render blurred unless
 * the user reveals them (all via the header toggle, or one by clicking it).
 * Text that cannot blur (toasts, dialogs, native tooltips) gets masked or
 * neutral wording instead, so nothing shows the plain value while hidden.
 */

import { createContext, useContext } from 'react';
import { maskEmails, stripCredentialExtension } from './display';

/**
 * Whether every private value is revealed. Defaults to revealed so components
 * shared with other pages (no provider there) keep showing names as before.
 */
export const PrivacyContext = createContext(true);

export const usePrivacyRevealed = () => useContext(PrivacyContext);

/** A credential name for plain-text channels: masked while hidden. */
export const plainIdentity = (name: string, revealed: boolean): string => {
  const label = stripCredentialExtension(name);
  return revealed ? label : maskEmails(label);
};
