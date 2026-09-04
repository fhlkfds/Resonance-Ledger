import { EntityIndexPage } from '@/components/entities/EntityIndexPage';

export default function AlbumsPage(props: PageProps<'/albums'>) {
  return <EntityIndexPage kind="album" searchParams={props.searchParams} />;
}
