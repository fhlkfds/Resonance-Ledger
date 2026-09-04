export default function Loading() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading dashboard">
      <div className="h-10 w-64 animate-pulse rounded bg-white/10" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-2xl bg-white/10"
          />
        ))}
      </div>
    </div>
  );
}
