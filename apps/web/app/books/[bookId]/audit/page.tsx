import { BookAuditPanel } from "../../../ui/book-audit";

export default async function BookAuditPage(
  props: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await props.params;
  return <BookAuditPanel bookId={decodeURIComponent(bookId)} />;
}
