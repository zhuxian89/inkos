import { BookWorkspace } from "../../ui/book-workspace";

export default async function BookPage(
  props: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await props.params;
  return <BookWorkspace bookId={decodeURIComponent(bookId)} />;
}
