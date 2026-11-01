import assert from "node:assert/strict";
import test from "node:test";
import { inlineImageSource, prepareInlineImages, removeInlineImage } from "../app/lib/inline-attachments.ts";

const picture = {
  id: "picture-1",
  type: "image/png",
  contentBase64: "YWJjZA==",
  disposition: "inline",
};

test("converts TipTap double-quoted image src to MIME CID", () => {
  const html = `<p>Hi</p><img src="${inlineImageSource(picture)}" alt="Sample"><img src="https://example.com/logo.png">`;
  const result = prepareInlineImages(html, [picture]);
  assert.match(result.html, /src="cid:img-picture-1"/);
  assert.match(result.html, /src="https:\/\/example.com\/logo.png"/);
  assert.equal(result.hasUnlinkedImage, false);
  assert.deepEqual([...result.referencedContentIds], ["img-picture-1"]);
});

test("also accepts single-quoted data URLs", () => {
  const result = prepareInlineImages(`<img alt='a' src='${inlineImageSource(picture)}'>`, [picture]);
  assert.match(result.html, /src="cid:img-picture-1"/);
  assert.equal(result.hasUnlinkedImage, false);
});

test("flags inline data images with no corresponding attachment", () => {
  const result = prepareInlineImages(`<img src="${inlineImageSource(picture)}">`, []);
  assert.equal(result.hasUnlinkedImage, true);
});

test("removing an image attachment removes just its associated editor image", () => {
  const html = `<p>Caption</p><img src="${inlineImageSource(picture)}"><img src="https://example.com/other.png">`;
  assert.equal(removeInlineImage(html, picture), '<p>Caption</p><img src="https://example.com/other.png">');
});

test("an editor-deleted inline image is no longer treated as referenced", () => {
  const result = prepareInlineImages("<p>No image remains</p>", [picture]);
  assert.equal(result.hasUnlinkedImage, false);
  assert.equal(result.referencedContentIds.size, 0);
});

test("does not alter the original attachment content", () => {
  const source = inlineImageSource(picture);
  prepareInlineImages(`<img src="${source}">`, [picture]);
  assert.equal(picture.contentBase64, "YWJjZA==");
});
