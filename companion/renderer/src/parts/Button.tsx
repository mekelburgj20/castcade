import { forwardRef, type ButtonHTMLAttributes } from 'react';

/**
 * The Arcaid look (2026-11-25): Castcade's button, on the model of Arcaid's `parts/Button` (its geometry and rules,
 * not its code). The look is `.cc-btn` in aw-castcade.css.
 *
 * - `primary`: the one thing a panel is for (Pair, Save, Patch my tables), in the lead: the kit's pink.
 * - `secondary`: an outline for the quieter choice beside it (Paste, Browse…, Preview).
 * - `danger`: anything that removes or cannot be undone (Unpair, Remove all Castcade patches), in the kit's red.
 *
 * `type="button"` unless the caller says otherwise, so a button inside a form never submits it by accident. The focus
 * ring is the layer's (cyan, never taken away).
 */
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'md' | 'sm' | 'xs';
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', size = 'md', type = 'button', className = '', ...rest }, ref) {
  return <button ref={ref} type={type} className={`cc-btn cc-btn--${variant} cc-btn--${size} ${className}`.trim()} {...rest} />;
});
