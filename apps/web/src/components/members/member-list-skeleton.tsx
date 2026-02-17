type MemberListSkeletonProps = {
  rows?: number;
};

export function MemberListSkeleton({ rows = 10 }: MemberListSkeletonProps) {
  return (
    <div className="px-2 py-2 space-y-1">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-2 rounded-md px-2 py-2 animate-pulse"
        >
          <div className="h-8 w-8 rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="h-3 w-2/3 rounded bg-muted" />
            <div className="h-2.5 w-1/3 rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default MemberListSkeleton;

