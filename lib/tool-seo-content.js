export const TOOL_SEO_CONTENT = {
  "/image-converter": {
    name: "the image converter",
    intro: "NativeMedia Agent converts common image formats without changing the source image’s pixel dimensions. It supports JPG, PNG, HEIC, TIFF, GIF, and BMP output, with per-image settings for batch work.",
    steps: [
      "Drop up to five supported images into the upload area, or browse from your device.",
      "Choose an output format and, when needed, set a target size for each image.",
      "Select Local agent and click Convert image to create new files on this computer.",
      "Review the result details, then download the converted files or retain a local result when that option is available.",
    ],
    trust: [
      "The first image preview stays in the browser until you submit the job; selecting a file alone does not upload it.",
      "Choose Local agent so the source is sent to the agent on this computer for processing.",
      "Image processing currently runs through the Local agent, so use it when the source should stay on this computer.",
    ],
    faqs: [
      ["Which image formats are supported?", "You can work with JPG, JPEG, PNG, HEIC, HEIF, TIFF, GIF, and BMP images. Available output options depend on the connected Local agent capabilities."],
      ["Can I convert several images at once?", "Yes. One request can include up to five images, and each image can have its own output format and optional size target."],
      ["Will conversion resize my image?", "No. The image converter keeps the original pixel dimensions. JPEG output can flatten transparency, and the interface warns you before that choice is submitted."],
    ],
  },
  "/video-repair": {
    name: "the video repair tool",
    intro: "The video repair tool tries safe recovery methods in layers, starting with readable-container fixes and moving to more involved recovery when the file needs it. It creates a new output and leaves the damaged source untouched.",
    steps: [
      "Add the damaged video and review the detected capabilities shown by the worker.",
      "If the file has missing MP4 metadata, add a healthy reference recording from the same device or app when requested.",
      "Select Local agent and start Repair video.",
      "Check the repaired result and worker log before downloading the new file.",
    ],
    trust: [
      "Local agent keeps the source and repair job on this computer.",
      "A reference video is sent to the Local agent with the repair job, so add one only when you are authorized to share it with this computer.",
      "Temporary local job data follows the agent cleanup rules, while results are retained only when you choose to keep them.",
    ],
    faqs: [
      ["Can every damaged video be repaired?", "No. Container metadata and timing problems may be recoverable, but missing or corrupted picture data can remain blank, frozen, or distorted."],
      ["When do I need a reference video?", "A healthy recording from the same device or app may be required when an MP4 or similar file is missing essential metadata. The reference should match the recording settings."],
      ["Does video repair overwrite my file?", "No. The worker creates a separate result file. Keep the original until you have checked that the recovered output contains the material you need."],
    ],
  },
  "/pdf-editor": {
    name: "the PDF editor",
    intro: "Use the PDF editor to build a new document from up to five PDFs, rearrange or remove pages, add blank pages, and place images or styled text boxes. The source documents remain unchanged.",
    steps: [
      "Add one or more PDFs, or start with a blank page.",
      "Drag pages into the order you want and remove pages that should not be included.",
      "Add blank pages, images, or text boxes and adjust their position and style in the page preview.",
      "Save the finished document as a new PDF and review the generated pages before downloading.",
    ],
    trust: [
      "The selected processing location is shown before export: Local agent sends the PDFs to this computer.",
      "Uploaded PDFs, previews, and generated results can exist in temporary Local agent storage while a job runs and follow the agent cleanup rules.",
      "Use the local retention option only when you want the final result kept on this device, and upload documents only when you are authorized to process them.",
    ],
    faqs: [
      ["Can I merge several PDFs?", "Yes. Add up to five PDFs, arrange their pages in the editor, and save the project as one new PDF."],
      ["Can I add text to a PDF?", "Yes. Add a text box, then choose its font, size, weight, underline, text colour, and background colour before placing it on a page."],
      ["Will my original PDF be changed?", "No. The editor creates a new PDF result. Keep the original if it contains advanced structures such as forms or attachments that are outside the editor’s supported guarantees."],
      ["Which keyboard shortcuts are available?", "Use ←/→ to rotate, ⌘/Ctrl+D to duplicate a page, ⌘/Ctrl+Z to undo, ⇧⌘/Ctrl+Z to redo, Delete to remove, +/- to zoom, ⌘/Ctrl+S to save to the device, and ⌘/Ctrl+Enter to export."],
    ],
  },
  "/pdf-text-editor": {
    name: "the PDF text editor",
    intro: "The PDF text editor lets you select and replace existing searchable PDF text while preserving the rest of the document where possible. Scanned, image-only pages can use the bundled OCR fallback for editable regions.",
    steps: [
      "Open one PDF and wait for its text runs or OCR regions to be identified.",
      "Select the text you want to change and edit it in place.",
      "Review the inherited font, size, colour, alignment, and background values before applying formatting changes.",
      "Save a new PDF, then check the preview and any export warnings before downloading.",
    ],
    trust: [
      "Choose Local agent when document text and OCR work should stay on this computer.",
      "PDF previews and OCR regions can contain sensitive document text, so use a processing location you trust and upload only authorized files.",
      "Temporary Local agent data follows the agent cleanup rules, while results are kept only when you explicitly choose local retention.",
    ],
    faqs: [
      ["Can I edit a scanned PDF?", "Yes, when OCR can identify text regions. OCR edits reconstruct the changed visual area and may not reproduce the original font or hidden pixels exactly."],
      ["Will the text editor reflow my document?", "No. Text is edited within its selected region. Longer replacements may overflow because surrounding page content is not automatically reflowed."],
      ["Is the exported PDF searchable?", "Native text replacements remain searchable when supported by the source font. OCR-based edits are visual reconstructions and may not add a new searchable text layer for the changed region."],
    ],
  },
  "/pdf-compressor": {
    name: "the PDF compressor",
    intro: "The PDF compressor reduces document size with selectable profiles for balanced output, smaller files, higher quality, or custom image settings. It keeps the original PDF untouched and returns a separate result.",
    steps: [
      "Add a PDF up to the displayed size limit.",
      "Choose Balanced, Smallest file, Higher quality, or Custom settings.",
      "Review the page-aware size estimate, then start Compress PDF.",
      "Compare the original and result details before downloading the optimized copy.",
    ],
    trust: [
      "Choose Local agent when the PDF should be processed on this computer.",
      "Compression can process document text and embedded images, so use the Local agent for confidential PDFs you want to keep on this computer.",
      "Temporary Local agent data follows the agent cleanup rules, while results are retained only when you choose to keep them on the device.",
    ],
    faqs: [
      ["Which compression setting should I choose?", "Balanced is a practical starting point. Choose Smallest file for sharing, Higher quality for image detail, or Custom when you need to control quality and colour settings."],
      ["Will compression reduce text quality?", "The compressor is designed to preserve readable document content. Image-heavy pages may be re-encoded, while the original PDF remains available for comparison."],
      ["Can I compress the same PDF again?", "The result is already an optimized copy for the chosen settings. Keep the original and adjust the profile only when you need a different quality or size trade-off."],
    ],
  },
  "/local-agent": {
    name: "the NativeMedia Agent",
    intro: "NativeMedia Agent runs supported media and PDF jobs on your own Mac, Windows, or Linux computer. It is useful when files should stay on the device throughout processing.",
    steps: [
      "Install and launch the agent for your operating system.",
      "Open the Local agent page and allow the website to check the loopback connection.",
      "Accept the agent’s legal documents and complete the required local authorization when prompted.",
      "Return to a tool, select Local agent as the processing location, and submit the job.",
    ],
    trust: [
      "In Local agent mode, the source file is sent to the agent on this computer; the licensing service does not receive media files.",
      "The agent uses a loopback connection and a short-lived browser session for the job instead of exposing a general file or shell interface.",
      "Temporary local results are cleaned up after download unless you choose to retain the final result; retained files stay until you remove them.",
    ],
    faqs: [
      ["Which operating systems support the local agent?", "Packaged installers are provided for macOS, Windows, and Linux. Use the installer that matches the computer where the files should be processed."],
      ["Does the local agent upload my source files?", "When a tool is set to Local agent, the browser sends the job to the agent on the same computer. The source file stays within this local processing workflow."],
      ["Why is the agent not detected?", "Make sure the installed agent is running, then use Check connection. Browser security, a stopped agent, or an authorization requirement can prevent the connection from becoming ready."],
    ],
  },
};
