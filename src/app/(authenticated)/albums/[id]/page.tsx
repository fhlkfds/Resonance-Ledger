import { EntityDetailPage } from '@/components/entities/EntityDetailPage';

export default async function AlbumDetailPage(
  props: PageProps<'/albums/[id]'>,
) {
  return (
    <EntityDetailPage
      id={(await props.params).id}
      kind="album"
      searchParams={props.searchParams}
    />
  );
}
