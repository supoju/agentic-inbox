// Helpers for image attachments embedded in the TipTap email editor.
// Keep source images unchanged; only replace their HTML data URLs with MIME Content-IDs.

export interface InlineAttachment {
  id: string;
  type: string;
  contentBase64: string;
  disposition: "attachment" | "inline";
}

const IMAGE_TAG = /<img\b[^>]*>/gi;
const SRC_ATTRIBUTE = /\bsrc\s*=\s*(["'])(.*?)\1/i;

export function inlineImageSource(attachment: InlineAttachment): string {
  return `data:${attachment.type};base64,${attachment.contentBase64}`;
}

export function removeInlineImage(html: string, attachment: InlineAttachment): string {
  const source = inlineImageSource(attachment);
  return html.replace(IMAGE_TAG, (tag) => {
    const match = tag.match(SRC_ATTRIBUTE);
    return match?.[2] === source ? "" : tag;
  });
}

export function prepareInlineImages(
  html: string,
  attachments: readonly InlineAttachment[],
): { html: string; hasUnlinkedImage: boolean; referencedContentIds: Set<string> } {
  const sources = new Map<string, string>();
  for (const attachment of attachments) {
    if (attachment.disposition !== "inline" || !attachment.type.startsWith("image/")) continue;
    const source = inlineImageSource(attachment);
    // Identical images can share one CID. An extra copy remains a normal attachment.
    if (!sources.has(source)) sources.set(source, `img-${attachment.id}`);
  }

  let hasUnlinkedImage = false;
  const referencedContentIds = new Set<string>();
  const convertedHtml = html.replace(IMAGE_TAG, (tag) => {
    const match = tag.match(SRC_ATTRIBUTE);
    if (!match || !match[2].startsWith("data:image/")) return tag;
    const contentId = sources.get(match[2]);
    if (!contentId) {
      hasUnlinkedImage = true;
      return tag;
    }
    referencedContentIds.add(contentId);
    return tag.replace(match[0], `src="cid:${contentId}"`);
  });

  return { html: convertedHtml, hasUnlinkedImage, referencedContentIds };
}
