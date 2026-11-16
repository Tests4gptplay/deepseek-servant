# Conversation attachments

## Local: choose files normally

Use **+ → File** to select images, videos or other files, drag files into the message box, or paste files from the clipboard. Pasted plain text is preserved alongside files. Folder attachments are not supported. In the DSH desktop app, a selected file with an available native Host path is referenced directly, without uploading a second copy. In an ordinary browser, selected file bytes are uploaded to the DSH Host's native attachment storage when you send the message. The conversation retains the resulting Host file reference. No manual Host path entry is needed. Selected PNG, JPEG, WebP and GIF images have thumbnails; click a thumbnail to open the Host’s image viewer. Other originals use the Host’s file-card presentation. Removing a selection closes its preview without changing the original.

Browser-selected files remain in the current page's conversation draft until sending. Removing an unsent selection does not upload it and does not delete or modify your original. These browser File objects are not restored after a page refresh or closing the browser; reselect them before sending. An upload or message failure keeps the current draft available for retry. A completed upload is reused when retrying the message.

Sent attachments remain available through their saved Host reference. **Open original** opens that file through the Host. Direct desktop references follow changes at the selected path; browser uploads are the copy captured when sending, not a live link to the browser computer. If a referenced Host file is moved, removed or becomes unreadable, the attachment reports the problem. DSS does not delete shared Host attachment objects when a composer selection is removed.

Local imposes no separate original-file size policy. Actual filesystem, Host attachment-provider and image-tool limits still apply.

## Git: keep repository originals

Git attachments retain their independent upload and download behavior. Each original is a single binary blob under `conversations/git/<collaboration>/attachments/`, with its repository reference and SHA-256. Each file must not exceed **104,857,600 bytes (100 MiB)**; repository, push and Host resource constraints also apply.

Git attachments upload through the DSH Host connection. Messages refer to stored originals; their contents are read when opened or supplied to a model. A failed or uncertain upload remains available to retry rather than appearing as sent.

Use **Download original** on a Git attachment to save its original file through the DSH Host connection. Private repository files are not published as public URLs.

## Reading and images

For Local, pass the actual absolute native path or its existing Local attachment reference directly to `dss_attachment_read`. Git uses its repository attachment reference. This tool does not require a second copy inside a task requirement, Worker contract or Cache record. Use the Host’s file-reading and processing tools within their existing permissions. An attachment does not grant access to neighboring files or its parent directory.

Local files use their selected or uploaded Host paths and use the Host’s existing file-reading and processing tools. DSS does not add a separate text paging endpoint or ordinary-file size limit. File availability is not proof that video frames, audio, PDF contents or transcription have been analyzed.

Local references provide the actual path, not image content. The Agent reads PNG, JPEG, WebP and GIF images, including extension-less images, with the Host’s native `read_image` tool through its current executor and existing permissions. `dss_attachment_read` can resolve a Local reference, but does not read its pixels. If the tool is unavailable, the model route does not support images, or access is denied, report the actual failure and retain the original path; DSS does not bypass it with a separate filesystem read. Successful image reads supply the Host’s actual native content. The Host image provider may normalize and store its own preview. That native visual step is separate from DSS original storage and does not mean the model has already analyzed the image. Its actual image byte limits and decoder errors apply to the affected image. A text-only model route still cannot perform visual analysis.

Git images use native image content independently, and other Git files use the native file provider with byte and hash verification. Missing optional image or file capabilities do not disable ordinary text conversation or DSS startup.
