import { EntityDetailPage } from '@/components/entities/EntityDetailPage';

export default async function TrackDetailPage(
  props: PageProps<'/tracks/[id]'>,
) {
  return (
    <EntityDetailPage
      id={(await props.params).id}
      kind="track"
      searchParams={props.searchParams}
    />
  );
}
