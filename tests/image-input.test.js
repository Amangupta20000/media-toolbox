import test from "node:test";
import assert from "node:assert/strict";
import { clipboardImageFile, imageExtensionForMime, isSupportedImageFile } from "../lib/image-input.js";

test("image upload accepts supported image MIME types and extensions", () => {
  assert.equal(isSupportedImageFile({ name: "portrait", type: "image/png" }), true);
  assert.equal(isSupportedImageFile({ name: "portrait.HEIC", type: "" }), true);
  assert.equal(isSupportedImageFile({ name: "portrait.jpg", type: "application/octet-stream" }), true);
  assert.equal(isSupportedImageFile({ name: "document.pdf", type: "application/pdf" }), false);
  assert.equal(isSupportedImageFile({ name: "clip.mp4", type: "video/mp4" }), false);
});

test("clipboard MIME types receive stable output extensions", () => {
  assert.equal(imageExtensionForMime("image/jpeg"), "jpg");
  assert.equal(imageExtensionForMime("image/heic"), "heic");
  assert.equal(imageExtensionForMime("image/unknown"), "png");
});

test("clipboard image items become uploadable image files", () => {
  const source = new File([Buffer.from("png")], "", { type: "image/png" });
  const file = clipboardImageFile({ items: [{ type: "image/png", getAsFile: () => source }] }, 123);
  assert.equal(file.name, "pasted-image-123.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, source.size);
});
