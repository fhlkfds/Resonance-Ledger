import Link from 'next/link';

export function Breadcrumbs({
  parent,
  parentHref,
  current,
}: {
  parent: string;
  parentHref: string;
  current: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6 text-sm text-muted">
      <ol className="flex flex-wrap items-center gap-2">
        <li>
          <Link className="hover:text-white" href={parentHref}>
            {parent}
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li aria-current="page" className="text-white">
          {current}
        </li>
      </ol>
    </nav>
  );
}
