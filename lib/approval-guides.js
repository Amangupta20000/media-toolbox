import { CONTENT_LAST_UPDATED } from "./site-metadata.js";

const GUIDE_AUTHOR = "Aman Gupta";

export const APPROVAL_GUIDES = {
  "/guides/convert-images-without-uploading": {
    path: "/guides/convert-images-without-uploading",
    title: "How to Convert Images Without Uploading Them",
    eyebrow: "Image conversion guide",
    summary: "A practical guide to choosing Browser mode or Local agent when you need a new image format but want to keep the source file in a local workflow.",
    lastUpdated: CONTENT_LAST_UPDATED,
    sections: [
      {
        heading: "When this workflow is useful",
        paragraphs: [
          "Image conversion is useful when an application accepts only one format, when a design needs a predictable PNG preview, or when a photo must be shared as a smaller JPG copy. The conversion should create a new file so the original remains available for comparison.",
          "NativeMedia Agent is designed for two different situations. Browser mode is convenient for a small supported conversion without installing software. Local agent is the better choice for larger images, desktop formats, and a workflow that should stay on the same computer.",
        ],
      },
      {
        heading: "How to convert an image",
        steps: [
          "Open the Image converter and choose Browser mode for a quick supported conversion, or connect the Local agent for larger files and more formats.",
          "Add up to five images. Check the displayed size limit before starting; Browser mode accepts up to 5 MB per image and Local agent accepts up to 25 MB per image.",
          "Choose the output format for each image. The converter keeps the original pixel dimensions unless the output format itself requires a change in how transparency is represented.",
          "Review the preview and conversion details, then download the new files. Keep the original until you have checked the result in the application where you intend to use it.",
        ],
      },
      {
        heading: "Formats, limits, and privacy",
        bullets: [
          "Browser mode supports common browser conversions such as PNG and JPG/JPEG and keeps supported files in the current browser session.",
          "Local agent supports JPG/JPEG, PNG, HEIC/HEIF, TIFF/TIF, GIF, and BMP when the installed capability is available.",
          "Selecting a file for preview does not submit it. The selected processing location is shown before the job begins.",
          "A JPG output cannot preserve transparent pixels in the same way as PNG. Review the warning and choose PNG when transparency matters.",
        ],
      },
      {
        heading: "Common problems",
        bullets: [
          "If a format is unavailable in Browser mode, use PNG or JPG/JPEG, or switch to Local agent for desktop format support.",
          "If an HEIC or TIFF preview is unavailable in the browser, the file may still be supported by the Local agent.",
          "If the output looks different, compare transparency, colour profile handling, and the application used to view the source and result.",
        ],
      },
    ],
    faqs: [
      ["Does image conversion upload my files?", "Supported Browser mode conversions stay in the current browser session. Local agent sends the job to the connected desktop agent so the file remains in that local processing workflow."],
      ["Will conversion resize my image?", "No. The image converter keeps the original pixel dimensions. Output format changes can still affect transparency or compression."],
      ["How many images can I convert?", "You can add up to five images in one request. Browser mode accepts up to 5 MB per image and Local agent accepts up to 25 MB per image."],
    ],
    relatedLinks: [
      ["/image-converter", "Open the image converter", "Convert JPG, PNG, GIF, BMP, HEIC, or TIFF images."],
      ["/guides/convert-svg-to-png", "SVG-to-PNG guide", "Understand vector dimensions, scaling, and transparent output."],
    ],
  },
  "/guides/convert-svg-to-png": {
    path: "/guides/convert-svg-to-png",
    title: "How to Export SVG as PNG With the Right Size",
    eyebrow: "SVG export guide",
    summary: "Understand intrinsic dimensions, export scale, custom sizes, backgrounds, and the privacy limits that affect SVG-to-PNG output.",
    lastUpdated: CONTENT_LAST_UPDATED,
    sections: [
      {
        heading: "What changes when SVG becomes PNG",
        paragraphs: [
          "SVG is vector artwork: its shapes are described mathematically and can be rendered at different sizes. PNG is a raster image made of pixels. Exporting an SVG therefore requires a target pixel size, even when the source has a viewBox that looks resolution-independent.",
          "The right output depends on where the image will be used. A 1× export is usually enough for a normal display size, while 2× or 3× can provide extra detail for high-density screens. Custom dimensions are useful when a design system requires an exact canvas.",
        ],
      },
      {
        heading: "How to convert an SVG",
        steps: [
          "Upload an SVG up to 25 MB or paste a complete SVG document into the converter.",
          "Choose 1×, 2×, 3×, or 4× to scale the intrinsic SVG dimensions. Use Custom when the exact output width and height are more important than the source size.",
          "Choose a transparent background for artwork that will sit on another surface, or choose a solid colour or gradient when the PNG should have its own canvas colour.",
          "Check the PNG preview before downloading. Compare the edges, text, embedded artwork, and background with the source SVG.",
        ],
      },
      {
        heading: "Browser mode and Local agent",
        paragraphs: [
          "Browser mode supports quick 1×–4× exports without uploading the SVG. It is useful for small, self-contained artwork and does not require the desktop application.",
          "Local agent adds custom output dimensions up to 8192 × 8192 pixels and is the better choice for larger artwork or a repeatable desktop workflow. Both modes block scripts, event handlers, external resources, and active embedded content.",
        ],
      },
      {
        heading: "Common rendering differences",
        bullets: [
          "External fonts, images, stylesheets, and filters may not render because external resources are blocked for privacy and safety.",
          "An opaque rectangle already inside the SVG can cover a transparent or styled background added by the converter.",
          "Keep aspect ratio enabled when entering custom dimensions unless stretching is intentional.",
          "Review Figma exports for embedded artwork and unsupported effects before relying on the PNG in production.",
        ],
      },
    ],
    faqs: [
      ["What do 1×, 2×, 3×, and 4× mean?", "They render the SVG at one, two, three, or four times its intrinsic dimensions. A higher scale creates more pixels and a larger output."],
      ["Can I choose an exact PNG size?", "Yes. Custom dimensions are available with Local agent and support output up to 8192 × 8192 pixels."],
      ["Why does my SVG look different in the preview?", "External fonts, images, stylesheets, scripts, and active embedded content are blocked. Use self-contained SVG artwork and review the preview before downloading."],
    ],
    relatedLinks: [
      ["/svg-to-png", "Open the SVG-to-PNG converter", "Rasterize SVG artwork with transparent, solid, or gradient backgrounds."],
      ["/image-converter", "Open the image converter", "Convert the resulting PNG or other raster image formats."],
    ],
  },
  "/guides/edit-and-merge-pdf": {
    path: "/guides/edit-and-merge-pdf",
    title: "How to Edit and Merge PDF Pages",
    eyebrow: "PDF editing guide",
    summary: "A practical workflow for combining PDF files, changing page order, adding pages or images, and exporting a new document without overwriting the originals.",
    lastUpdated: CONTENT_LAST_UPDATED,
    sections: [
      {
        heading: "What the PDF editor is designed to do",
        paragraphs: [
          "The PDF editor is for page-level work: combining documents, removing pages, changing their order, rotating pages, adding blank pages, placing images, and adding supported text boxes. It creates a new PDF rather than modifying the source documents in place.",
          "This is different from a full word processor. Existing page content is not automatically reflowed when a new text box is added, and advanced PDF structures such as forms or attachments should be checked after export.",
        ],
      },
      {
        heading: "How to merge and edit pages",
        steps: [
          "Choose Browser mode for lightweight work or Local agent for advanced editing and larger supported inputs.",
          "Add the PDFs you are authorized to use. The standard workflow accepts up to five PDFs; Browser mode has a 50 MB total import limit and Local agent has a 200 MB total limit.",
          "Drag pages into the required order, remove pages that should not be included, and add blank pages or images when needed.",
          "Use Local agent when you need styled text boxes, more image formats, duplicate-page actions, OCR, or other advanced PDF features.",
          "Export a new PDF and inspect page count, order, text placement, images, and any warnings before replacing or sharing the source document.",
        ],
      },
      {
        heading: "Browser mode and Local agent",
        bullets: [
          "Browser mode is useful for quick page ordering, merging, rotation, deletion, blank pages, and small PNG/JPG/JPEG additions.",
          "Local agent is recommended for larger files, password-protected documents, styled text boxes, duplicate pages, OCR, and local History.",
          "Browser mode keeps the temporary project in the browser and creates a download-only result. Local agent can retain a final result only when you choose that option.",
          "Always keep a copy of the original PDFs until the exported document has been checked in the viewer or workflow where it will be used.",
        ],
      },
      {
        heading: "Common PDF editing mistakes",
        bullets: [
          "Adding a text box does not automatically push surrounding content down. Leave enough space for the new text.",
          "A password-protected PDF may need to be unlocked before it can be imported.",
          "A page can look correct in the editor but still need a final check for fonts, images, forms, and attachments after export.",
        ],
      },
    ],
    faqs: [
      ["Can I merge several PDFs?", "Yes. Add up to five PDFs, arrange their pages, and export them as one new PDF. Browser mode can import browser-renderable PDFs up to 50 MB total."],
      ["Will the editor change my original files?", "No. It creates a new PDF result and leaves the source files untouched."],
      ["When should I use Local agent?", "Use Local agent for larger documents, advanced text boxes, duplicate pages, OCR, password-protected PDFs, more image formats, and local History."],
    ],
    relatedLinks: [
      ["/pdf-editor", "Open the PDF editor", "Merge, reorder, rotate, and export PDF pages."],
      ["/pdf-text-editor", "Open the PDF text editor", "Replace searchable text or use OCR-supported editing."],
    ],
  },
  "/guides/compress-pdf": {
    path: "/guides/compress-pdf",
    title: "How to Compress a PDF Without Losing More Quality Than Needed",
    eyebrow: "PDF compression guide",
    summary: "Learn how to choose a compression profile, understand image-heavy documents, preserve searchable text where possible, and verify the exported PDF.",
    lastUpdated: CONTENT_LAST_UPDATED,
    sections: [
      {
        heading: "Why PDF size changes",
        paragraphs: [
          "PDF size is often driven by scanned pages, photographs, embedded fonts, and repeated image resources. A document with mostly text may already be compact, while a scan can become much smaller when its page images are re-encoded.",
          "There is no single best compression setting for every document. A smaller file may use more aggressive image compression, while a higher-quality result may preserve more detail at the cost of size.",
        ],
      },
      {
        heading: "How to compress a PDF",
        steps: [
          "Add a PDF and check the displayed input limit. Browser mode accepts PDFs up to 10 MB and 100 pages.",
          "Choose Balanced for a practical first result. Use Smallest file when sharing limits matter more than detail, or Higher quality when images and fine text need more protection.",
          "Use Local agent for larger documents, custom image settings, and cases where preserving searchable text is important.",
          "Compare the result size and open several representative pages. Check small text, diagrams, photographs, links, and searchable text before sharing the compressed copy.",
        ],
      },
      {
        heading: "Choosing the right profile",
        bullets: [
          "Balanced is a good starting point for ordinary documents and mixed text/image PDFs.",
          "Smallest file is appropriate when upload limits or email attachment size are the main constraint.",
          "Higher quality is useful when the PDF contains photographs, scans, diagrams, or fine print that should remain easy to inspect.",
          "Custom settings are available through Local agent when the standard profiles do not provide the desired image-quality and size trade-off.",
        ],
      },
      {
        heading: "Privacy and common mistakes",
        paragraphs: [
          "Browser mode keeps supported compression work in the current browser and creates a download-only result. Local agent processes the file on the connected computer and can retain the final copy only when you choose to do so.",
          "Do not overwrite the original before checking the result. Image-heavy pages may be rebuilt and selectable text can change on rebuilt pages, so keep the source available for comparison.",
        ],
      },
    ],
    faqs: [
      ["Which compression setting should I choose?", "Start with Balanced. Choose Smallest file when the size limit is strict, Higher quality when visual detail matters, and Custom with Local agent when you need more control."],
      ["Will compression remove searchable text?", "The compressor is designed to preserve document content where the selected processing pass supports it, but image-heavy pages may be rebuilt. Check searchable text after export when it matters."],
      ["Can I compress a PDF in Browser mode?", "Yes. Browser mode accepts PDFs up to 10 MB and 100 pages and provides the Balanced profile for quick compression."],
    ],
    relatedLinks: [
      ["/pdf-compressor", "Open the PDF compressor", "Reduce a PDF copy with balanced or advanced profiles."],
      ["/pdf-editor", "Open the PDF editor", "Remove unnecessary pages before compression."],
    ],
  },
};

export const GUIDE_INDEX = [
  ...Object.values(APPROVAL_GUIDES).map(({ path, title, eyebrow, summary }) => ({ path, title, eyebrow, summary })),
  {
    path: "/browser-vs-local-agent",
    title: "Browser Mode vs Local Agent",
    eyebrow: "Privacy and processing guide",
    summary: "Compare file handling, limits, installation needs, and the right processing location for each kind of job.",
  },
];

export { GUIDE_AUTHOR };
