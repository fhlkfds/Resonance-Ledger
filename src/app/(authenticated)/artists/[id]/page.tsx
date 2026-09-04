import { EntityDetailPage } from '@/components/entities/EntityDetailPage';

export default async function ArtistDetailPage(
  props: PageProps<'/artists/[id]'>,
) {
  return (
    <EntityDetailPage
      id={(await props.params).id}
      kind="artist"
      searchParams={props.searchParams}
    />
  );
}
