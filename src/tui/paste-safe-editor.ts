import { CustomEditor } from "@earendil-works/pi-coding-agent";

/**
 * Host operations such as dequeue, editor replacement and dialogs snapshot the
 * editor through getText(), then restore it with setText(). Native getText()
 * returns paste markers, but setText() clears the map holding their payloads.
 * Expose full text at that boundary; native rendering/cursor handling still use
 * the compact internal lines. getExpandedText() reads those lines directly, so
 * this does not recurse or expand marker-looking text without a stored paste.
 */
export class PasteSafeEditor extends CustomEditor {
  override getText(): string {
    return super.getExpandedText();
  }
}
