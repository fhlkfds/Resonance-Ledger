// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DebouncedSearchInput } from '@/components/filters/DebouncedSearchInput';

afterEach(() => vi.useRealTimers());

it('submits its GET form 300ms after the last search change', () => {
  vi.useFakeTimers();
  const { container } = render(
    <form action="/tracks" method="get">
      <DebouncedSearchInput defaultValue="" label="Search tracks" />
      <select name="range" defaultValue="LAST_30_DAYS">
        <option>LAST_30_DAYS</option>
      </select>
    </form>,
  );
  const submit = vi.fn();
  container.querySelector('form')!.requestSubmit = submit;
  const input = screen.getByRole('searchbox', { name: 'Search tracks' });
  fireEvent.change(input, { target: { value: 'first' } });
  vi.advanceTimersByTime(200);
  fireEvent.change(input, { target: { value: 'final' } });
  vi.advanceTimersByTime(299);
  expect(submit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(submit).toHaveBeenCalledOnce();
});
