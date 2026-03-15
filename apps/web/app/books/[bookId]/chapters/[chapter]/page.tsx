import { ChapterDetailPage } from "../../../../ui/chapter-detail";

export default async function ChapterPage(
  props: { params: Promise<{ bookId: string; chapter: string }> },
) {
  const { bookId, chapter } = await props.params;
  return <ChapterDetailPage bookId={decodeURIComponent(bookId)} chapter={decodeURIComponent(chapter)} />;
}
