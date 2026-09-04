import { EntityIndexPage } from '@/components/entities/EntityIndexPage';

export default function ArtistsPage(props: PageProps<'/artists'>) {
  return <EntityIndexPage kind="artist" searchParams={props.searchParams} />;
}
