import { EntityIndexPage } from '@/components/entities/EntityIndexPage';

export default function TracksPage(props: PageProps<'/tracks'>) {
  return <EntityIndexPage kind="track" searchParams={props.searchParams} />;
}
