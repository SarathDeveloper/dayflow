import React from 'react';

/** A labelled on/off switch row (44px touch target), used by Settings and the Notifications page. */
export function SettingSwitch({ label, description, checked, disabled, onChange }: {
  label: string;
  /** Optional line under the label. */
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 py-1 text-sm font-medium has-disabled:cursor-default has-disabled:opacity-60">
      <span className="min-w-0">
        <span className="block">{label}</span>
        {description && (
          <span className="block text-xs font-normal leading-snug text-slate-500 dark:text-slate-400">{description}</span>
        )}
      </span>
      <span className="relative shrink-0">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
        />
        <span aria-hidden="true" className="relative block h-6 w-11 rounded-full bg-slate-200 transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-indigo-600 peer-checked:after:translate-x-5 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-indigo-500 dark:bg-slate-700" />
      </span>
    </label>
  );
}
