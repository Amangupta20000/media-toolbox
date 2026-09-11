import { PDFDocument, degrees } from "pdf-lib";

function postProgress(progress) {
  self.postMessage({ type: "progress", progress });
}

self.onmessage = async ({ data }) => {
  try {
    const { files, pages } = data;
    const output = await PDFDocument.create();
    const sourceDocuments = [];

    for (const [sourceIndex, file] of files.entries()) {
      sourceDocuments.push(await PDFDocument.load(new Uint8Array(file.bytes), {
        updateMetadata: false,
        throwOnInvalidObject: false,
      }));
      postProgress(20 + Math.round(((sourceIndex + 1) / Math.max(1, files.length)) * 20));
    }

    for (const [index, page] of pages.entries()) {
      let target;
      if (page.kind === "source") {
        const [copied] = await output.copyPages(sourceDocuments[page.pdfIndex], [page.pageIndex]);
        target = output.addPage(copied);
      } else if (page.kind === "raster") {
        target = output.addPage([page.width, page.height]);
        if (page.rotation) target.setRotation(degrees(page.rotation));
        const embedded = page.baseImage.extension === ".png"
          ? await output.embedPng(new Uint8Array(page.baseImage.bytes))
          : await output.embedJpg(new Uint8Array(page.baseImage.bytes));
        target.drawImage(embedded, {
          x: 0,
          y: 0,
          width: target.getWidth(),
          height: target.getHeight(),
        });
      } else {
        target = output.addPage([page.width, page.height]);
        if (page.rotation) target.setRotation(degrees(page.rotation));
      }

      for (const image of page.images || []) {
        const embedded = image.extension === ".png"
          ? await output.embedPng(new Uint8Array(image.bytes))
          : await output.embedJpg(new Uint8Array(image.bytes));
        target.drawImage(embedded, {
          x: image.x,
          y: target.getHeight() - image.y - image.height,
          width: image.width,
          height: image.height,
        });
      }
      postProgress(40 + Math.round(((index + 1) / Math.max(1, pages.length)) * 32));
    }

    postProgress(72);
    const bytes = await output.save();
    self.postMessage({ type: "complete", bytes: bytes.buffer }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "The browser PDF worker could not create the PDF.",
    });
  }
};
