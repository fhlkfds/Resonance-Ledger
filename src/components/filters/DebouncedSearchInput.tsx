'use client';

import { useEffect, useRef } from 'react';

export function DebouncedSearchInput({
  defaultValue,
  label,
}: {
  defaultValue: string;
  label: string;
}) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <input
      aria-label={label}
      className="min-w-0 rounded-lg border border-white/15 bg-background px-3 py-2"
      defaultValue={defaultValue}
      maxLength={200}
      name="q"
      type="search"
      onChange={(event) => {
        clearTimeout(timer.current);
        const form = event.currentTarget.form;
        timer.current = setTimeout(() => form?.requestSubmit(), 300);
      }}
    />
  );
}
