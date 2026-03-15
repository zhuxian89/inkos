import { BookChapters } from "../../../ui/book-chapters";

export default async function BookChaptersPage(
  props: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await props.params;
  return <BookChapters bookId={decodeURIComponent(bookId)} />;
}
