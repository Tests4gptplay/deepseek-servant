# Conversation attachments

## Local: use the selected original

In the DSH desktop app, choose a saved image, video or file. Local keeps its actual native path in the conversation and reads the original there. It does not upload the original into DSS storage, make a second DSS copy, split it into parts or create an attachment manifest.

In a served browser, **Attach Host file** accepts the absolute path of a file that already exists on the computer running the DSH Host. The path is interpreted on that Host, not on the browser computer. If both are the same computer, they may be the same file. A file selected only on a remote browser computer is not automatically uploaded or made available on the Host. The Desktop file picker remains available when its native path bridge is present.

The attachment card shows the original path. **Open original** opens that file through the desktop Host. Normal edits and file replacements at the same path remain visible on the next read. The size shown when selecting a file is an observation, not a frozen version. If the original is moved, removed or becomes unreadable, that attachment reports the problem. Select its new location when necessary.

A pasted screenshot or generated image may have no saved native file path. In that case, only that attachment needs attention: save the original and choose the saved file. DSS does not guess a path or silently switch to copying it. Older Local stored-attachment representations are not converted or read as native originals.

Local attachment selection uses the existing desktop connection and does not require a raw-byte upload carrier. It imposes no overall original-file size policy. Actual filesystem, image-provider and tool-response limits still apply.

## Git: keep repository originals

Git attachments retain their independent upload and download behavior. Each original is a single binary blob under `conversations/git/<collaboration>/attachments/`, with its repository reference and SHA-256. Each file must not exceed **104,857,600 bytes (100 MiB)**; repository, push and Host resource constraints also apply.

Git attachments upload through the DSH Host connection. Messages refer to stored originals; their contents are read when opened or supplied to a model. A failed or uncertain upload remains available to retry rather than appearing as sent.

Use **Download original** on a Git attachment to save its original file through the DSH Host connection. Private repository files are not published as public URLs.

## Reading and images

For Local, pass the actual absolute native path or its existing Local attachment reference directly to `dss_attachment_read`. Git uses its repository attachment reference. This tool does not require a second copy inside a task requirement, Worker contract or Cache record. Use the Host’s file-reading and processing tools within their existing permissions. An attachment does not grant access to neighboring files or its parent directory.

Local files remain at their original native paths and use the Host’s existing file-reading and processing tools. DSS does not add a separate text paging endpoint or ordinary-file size limit. File availability is not proof that video frames, audio, PDF contents or transcription have been analyzed.

Local PNG, JPEG, WebP and GIF paths use the Host’s `read_image` tool with the current Agent and its existing permissions. An extension-less image can be read with that native tool directly. If the tool is unavailable, the model route does not support images, or access is denied, report the actual failure and retain the original path; DSS does not bypass it with a separate filesystem read. Successful image reads supply the Host’s actual native content. The Host image provider may normalize and store its own preview. That native visual step is separate from DSS original storage and does not mean the model has already analyzed the image. Its actual image byte limits and decoder errors apply to the affected image. A text-only model route still cannot perform visual analysis.

Git images use native image content independently, and other Git files use the native file provider with byte and hash verification. Missing optional image or file capabilities do not disable ordinary text conversation or DSS startup.
